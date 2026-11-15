import { appContext } from '../../../../../server/context.ts';
import { handleOidcCallback } from '../../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const GET = (req: Request) => handleOidcCallback(req, appContext());
