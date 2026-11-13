// Runs once when the server process starts. While no administrator exists, prints the setup notice (and the generated
// setup token, if TALLYMED_SETUP_TOKEN is empty) to the console. Nothing is printed once an administrator exists.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { announceSetupWhenNeeded } = await import('./server/setup-announce.ts');
  void announceSetupWhenNeeded();
}
