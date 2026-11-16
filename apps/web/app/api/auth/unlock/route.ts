import { appContext } from '../../../../server/context.ts';
import { handleUnlock } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleUnlock(req, appContext());
