import { appContext } from '../../../../server/context.ts';
import { handleForgotPassword } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleForgotPassword(req, appContext());
