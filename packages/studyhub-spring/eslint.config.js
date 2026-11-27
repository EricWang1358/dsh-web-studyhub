// ESLint 10 resolves flat configuration from each target file's directory.
// Keep the independent Maven reactor and its staged Node distribution out of the root lint run.
export default [{ ignores: ['**/*'] }];
