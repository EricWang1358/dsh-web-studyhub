/* Environment isolation for QA runs. The owner's shell carries real provider
   keys (DEEPSEEK_API_KEY, ANTHROPIC_BASE_URL, ...) and DSH ranks inherited
   variables above $DSH_HOME/.credentials.yaml, so every server or browser a QA
   script starts gets an environment with all of them removed. */

/** Names that carry credentials or redirect model traffic. */
const SECRET_NAME = /API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|BASE_?URL|ACCESS_?KEY|(^|_)AUTH(_|$)/i;

/** The variable names scrubSecrets would remove. */
export const secretEnvNames = (env = process.env) => Object.keys(env).filter((name) => SECRET_NAME.test(name));

/** A copy of `env` without any key, token, secret, password, credential or base-url variable. */
export function scrubSecrets(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAME.test(name)));
}

/** Remove them from this process too, so in-process servers and launched browsers never see them. */
export function scrubProcessEnv() {
  const removed = secretEnvNames(process.env);
  for (const name of removed) delete process.env[name];
  return removed;
}
