import { appContext } from '../../../../server/context.ts';
import { handleResetPassword } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleResetPassword(req, appContext());
