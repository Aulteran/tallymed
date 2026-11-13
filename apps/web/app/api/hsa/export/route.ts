import { appContext } from '../../../../server/context.ts';
import { handleHsaExport } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const GET = async (req: Request) => handleHsaExport(req, appContext());
