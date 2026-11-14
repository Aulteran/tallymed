import { appContext } from '../../server/context.ts';
import { refreshRuntimeConfig } from '../../server/settings.ts';

/** License and corresponding-source notice shown in every private page (AGPL-3.0-only). */
export async function SourceNotice() {
  // The link is an administrator setting (Settings > General) that falls back to TALLYMED_SOURCE_URL.
  const { config, pool } = appContext();
  await refreshRuntimeConfig(config, pool);
  const source = config.sourceUrl;
  return <footer className="notice">
    <p>
      TallyMed is free software under the GNU Affero General Public License, version 3 only, and comes with no warranty.
      {' '}{source
        ? <>Corresponding source for this running build: <a href={source}>{source}</a>.</>
        : <>The operator has not configured a corresponding-source link.</>}
    </p>
  </footer>;
}
