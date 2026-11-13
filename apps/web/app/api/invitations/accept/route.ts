import { appContext } from '../../../../server/context.ts';
import { handleAcceptInvitation } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleAcceptInvitation(req, appContext());
