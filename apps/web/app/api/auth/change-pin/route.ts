import { appContext } from '../../../../server/context.ts';
import { handleChangePin } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleChangePin(req, appContext());
