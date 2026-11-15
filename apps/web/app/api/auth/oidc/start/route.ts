import { appContext } from '../../../../../server/context.ts';
import { handleOidcStart } from '../../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const GET = (req: Request) => handleOidcStart(req, appContext());
