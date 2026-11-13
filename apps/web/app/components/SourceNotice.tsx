import { sourceUrl } from '../../server/config.ts';

/** License and corresponding-source notice shown in every private page (AGPL-3.0-only). */
export function SourceNotice() {
  const source = sourceUrl(process.env.TALLYMED_SOURCE_URL);
  return <footer className="notice">
    <p>
      TallyMed is free software under the GNU Affero General Public License, version 3 only, and comes with no warranty.
      {' '}{source
        ? <>Corresponding source for this running build: <a href={source}>{source}</a>.</>
        : <>The operator has not configured a corresponding-source link.</>}
    </p>
  </footer>;
}
