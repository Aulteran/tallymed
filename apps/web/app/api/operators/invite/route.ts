import { appContext } from '../../../../server/context.ts';
import { handleInvite } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleInvite(req, appContext());
