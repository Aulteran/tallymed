import { appContext } from '../../../../../server/context.ts';
import { handleRevokeInvitation } from '../../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleRevokeInvitation(req, appContext());
