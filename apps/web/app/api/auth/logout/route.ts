import { appContext } from '../../../../server/context.ts';
import { handleLogout } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleLogout(req, appContext());
