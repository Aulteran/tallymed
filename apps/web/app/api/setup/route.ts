import { appContext } from '../../../server/context.ts';
import { handleSetup } from '../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleSetup(req, appContext());
