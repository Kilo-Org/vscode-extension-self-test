export default async function () {
  return {
    "shell.env": async (input: { sessionID?: string }, output: { env: Record<string, string> }) => {
      // Clear inherited identity when the caller has no session.
      output.env.KILO_SELF_TEST_SESSION = input.sessionID ?? ""
    },
  }
}
