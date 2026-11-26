import http from 'node:http'
import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { startHarmonyMjpegServer } from './harmony-mjpeg-server'

type Subscription = {
  res: http.IncomingMessage
  chunks: Buffer[]
  destroy: () => void
}

function subscribe(url: string): Promise<Subscription> {
  return new Promise((resolve, reject) => {
    const req = http.get(url)
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      resolve({
        res,
        chunks,
        destroy: () => {
          req.destroy()
          res.destroy()
        }
      })
    })
    req.on('error', reject)
  })
}

function statusOf(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        resolve(res.statusCode ?? 0)
        res.destroy()
      })
      .on('error', reject)
  })
}

// The capture loop is timer-driven; fake timers make frame delivery deterministic while real
// loopback HTTP still completes between advances (IO is not faked).
async function advanceUntil(assertion: () => void, maxMs = 1_000, stepMs = 15): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs)
    try {
      assertion()
      return
    } catch {
      // The frame has not been delivered yet; advance another capture interval.
    }
  }
  assertion()
}

// A streaming response flushes its headers together with the first frame, which the fake-timer
// capture loop produces, so advance the clock while waiting for the subscription to open.
async function subscribeDriven(url: string): Promise<Subscription> {
  let result: Subscription | undefined
  let failure: unknown
  const pending = subscribe(url).then(
    (value) => {
      result = value
    },
    (reason) => {
      failure = reason
    }
  )
  for (
    let elapsed = 0;
    elapsed < 1_000 && result === undefined && failure === undefined;
    elapsed += 15
  ) {
    await vi.advanceTimersByTimeAsync(15)
  }
  if (result === undefined && failure === undefined) {
    throw new Error('timed out waiting for the MJPEG subscription to receive a frame')
  }
  await pending
  if (failure !== undefined) {
    throw failure
  }
  return result!
}

describe('startHarmonyMjpegServer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('serves multipart JPEG frames to subscribers', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0xff, 0xd9])
    const captureFrame = vi.fn(async () => jpeg)
    const server = await startHarmonyMjpegServer({ captureFrame, frameIntervalMs: 15 })

    const sub = await subscribeDriven(server.streamUrl)
    expect(sub.res.headers['content-type']).toBe(
      'multipart/x-mixed-replace; boundary=orca-harmony-frame'
    )

    await advanceUntil(() => {
      const received = Buffer.concat(sub.chunks)
      expect(received.includes('--orca-harmony-frame')).toBe(true)
      expect(received.includes(jpeg)).toBe(true)
    })

    sub.destroy()
    await server.stop()
  })

  it('returns 404 for other paths', async () => {
    const server = await startHarmonyMjpegServer({
      captureFrame: vi.fn(),
      frameIntervalMs: 15
    })
    const origin = new URL(server.streamUrl).origin
    expect(await statusOf(`${origin}/other`)).toBe(404)
    await server.stop()
  })

  it('drops frames for a saturated subscriber until drain', async () => {
    const frames = [Buffer.from('f1'), Buffer.from('f2'), Buffer.from('f3')]
    let frameIndex = 0
    let requestHandler: (req: unknown, res: unknown) => void
    const fakeListen = (_port: number, _host: string, onListening: () => void): void =>
      onListening()
    const fakeServer = {
      listen: fakeListen,
      address: () => ({ port: 1 }),
      close: (onClose: () => void) => onClose()
    }
    const server = await startHarmonyMjpegServer({
      frameIntervalMs: 5,
      captureFrame: async () => frames[frameIndex++] ?? frames[0]!,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fake http.Server; only listen/address/close are used.
      createServer: ((handler) => {
        requestHandler = handler
        return fakeServer
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: matches the injected createServer contract.
      }) as unknown as typeof http.createServer
    })

    const res = new EventEmitter()
    let writes = 0
    Object.assign(res, {
      writableEnded: false,
      destroyed: false,
      destroy: () => {},
      writeHead: () => {},
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fake ServerResponse; broadcast reads writableEnded/destroyed/write only.
      write: () => {
        writes += 1
        return false
      }
    })
    requestHandler!({ url: '/stream.mjpeg' }, res)

    await vi.advanceTimersByTimeAsync(60)
    expect(writes).toBe(1)
    res.emit('drain')
    await advanceUntil(() => expect(writes).toBeGreaterThan(1), 100, 5)

    await server.stop()
  })

  it('only captures while a client is subscribed', async () => {
    const captureFrame = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const server = await startHarmonyMjpegServer({ captureFrame, frameIntervalMs: 15 })

    await vi.advanceTimersByTimeAsync(80)
    expect(captureFrame).not.toHaveBeenCalled()

    const sub = await subscribeDriven(server.streamUrl)
    // Opening the subscription drove the first capture-loop frame.
    expect(captureFrame).toHaveBeenCalled()

    sub.destroy()
    // Settle the in-flight capture; afterwards the loop sees no subscribers and pauses.
    await vi.advanceTimersByTimeAsync(15)
    const callsAfterUnsubscribe = captureFrame.mock.calls.length
    await vi.advanceTimersByTimeAsync(80)
    expect(captureFrame.mock.calls.length).toBe(callsAfterUnsubscribe)

    await server.stop()
  })
})
