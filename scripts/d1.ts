import { spawnSync } from "node:child_process"

export const runWrangler = (args: string[]): string => {
  const child = spawnSync("bun", ["x", "--no-install", "wrangler", ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
  })
  if (child.status !== 0)
    throw new Error(
      `Wrangler failed: ${child.stderr || child.error?.message || "command failed"}`,
    )
  return child.stdout
}

export const executeSql = (
  sql: string,
  remote: boolean,
): Array<Record<string, unknown>> => {
  const result = JSON.parse(
    runWrangler([
      "d1",
      "execute",
      "tisearch",
      remote ? "--remote" : "--local",
      "--command",
      sql,
      "--json",
    ]),
  ) as Array<{ results: Record<string, unknown>[] }>
  return result.flatMap((r) => r.results)
}
