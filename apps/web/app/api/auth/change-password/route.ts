import { appContext } from '../../../../server/context.ts';
import { handleChangePassword } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleChangePassword(req, appContext());
