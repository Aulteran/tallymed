import { appContext } from '../../../../server/context.ts';
import { handleUpdateOperator } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleUpdateOperator(req, appContext());
