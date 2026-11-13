export const dynamic = 'force-dynamic';

function sourceUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export default function Page() {
  const source = sourceUrl(process.env.TALLYMED_SOURCE_URL);
  return <main>
    <h1>TallyMed</h1>
    <p>Development shell. The private household ledger is planned.</p>
    <p>GNU AGPL v3{source && <> · <a href={source}>Corresponding source</a></>}</p>
  </main>;
}
