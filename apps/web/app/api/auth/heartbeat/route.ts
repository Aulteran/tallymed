import { appContext } from '../../../../server/context.ts';
import { handleHeartbeat } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleHeartbeat(req, appContext());
