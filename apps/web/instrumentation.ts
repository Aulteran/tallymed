// Runs once when the server process starts. Records each request's TCP peer address (for the trusted-proxy check), then, while no
// administrator exists, prints the setup notice (and the generated setup token, if TALLYMED_SETUP_TOKEN is empty) to the console.
// Nothing is printed once an administrator exists.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { installPeerStamp } = await import('./server/peer.ts');
  installPeerStamp();
  const { announceSetupWhenNeeded } = await import('./server/setup-announce.ts');
  void announceSetupWhenNeeded();
}
