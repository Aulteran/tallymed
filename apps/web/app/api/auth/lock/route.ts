import { appContext } from '../../../../server/context.ts';
import { handleLock } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleLock(req, appContext());
