import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { localSnapshotPath, startHarmonyStreamSession } from './harmony-stream-session-starter'
import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'

const SDK: HarmonySdkPaths = {
  sdkRoot: '/sdk',
  hdc: '/sdk/hdc',
  emulator: '/sdk/Emulator'
}

const KEY = '127.0.0.1:5555'

describe('localSnapshotPath', () => {
  it('sanitizes the connectKey into a tmp JPEG filename', () => {
    expect(localSnapshotPath(KEY)).toBe(join(tmpdir(), 'orca-harmony-127-0-0-1-5555.jpeg'))
  })
})

describe('startHarmonyStreamSession', () => {
  it('reports mjpeg session info and serves real snapshot frames', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20, 0xff, 0xd9])
    const local = localSnapshotPath(KEY)
    // The fake runner performs no real transfer; the "pulled" file is pre-staged.
    await writeFile(local, jpeg)

    const runner = vi.fn<HarmonyCommandRunner>(async (_binary, args) => {
      if (args.includes('snapshot_display')) {
        return { stdout: 'success: saved as jpeg, width: 100, height: 200', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: '', code: 0 }
    })

    const { info, handle } = await startHarmonyStreamSession({
      runner,
      sdk: SDK,
      connectKey: KEY,
      frameIntervalMs: 15
    })

    expect(info).toMatchObject({
      deviceUdid: KEY,
      streamCodec: 'mjpeg',
      backend: 'harmonyos',
      wsUrl: ''
    })
    expect(info.streamUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/stream\.mjpeg$/)

    // Fake timers drive the capture loop; real loopback delivery and file reads still run.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chunks: Buffer[] = []
    let settled = false
    const frameArrived = new Promise<void>((resolve, reject) => {
      const req = http.get(info.streamUrl, (res) => {
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          if (Buffer.concat(chunks).includes(jpeg)) {
            req.destroy()
            res.destroy()
            resolve()
          }
        })
      })
      req.on('error', reject)
      setTimeout(() => {
        req.destroy()
        reject(new Error('no frame received'))
      }, 2000)
    })
    void frameArrived.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    try {
      for (let elapsed = 0; elapsed < 2000 && !settled; elapsed += 15) {
        await vi.advanceTimersByTimeAsync(15)
      }
      await frameArrived

      expect(Buffer.concat(chunks).includes('--orca-harmony-frame')).toBe(true)
      handle.close()
      await vi.advanceTimersByTimeAsync(50)
    } finally {
      vi.useRealTimers()
    }
    await rm(local, { force: true })
  })
})
