/* eslint-env jest */
import { spawnSync } from 'child_process'
import path from 'path'

// Runs the pure-shell regression suite (test/sndev/monero-commands.sh) so the
// `sndev monero` stack-safety contract is enforced by the standard jest suite.
// See the .sh header for the incident background: an implicit base-file-only
// `docker compose up` from read paths silently recreated production containers
// without their override files.
describe('sndev monero stack-safety (shell)', () => {
  test('monero subcommands never mutate the compose stack implicitly', () => {
    const script = path.resolve(process.cwd(), 'test', 'sndev', 'monero-commands.sh')
    const res = spawnSync('bash', [script], { encoding: 'utf8', timeout: 120000 })
    if (res.status !== 0) {
      console.error(res.stdout)
      console.error(res.stderr)
    }
    expect(res.status).toBe(0)
  })
})
