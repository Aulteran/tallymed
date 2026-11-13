import { appContext } from '../../../../server/context.ts';
import { handleLogin } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleLogin(req, appContext());
