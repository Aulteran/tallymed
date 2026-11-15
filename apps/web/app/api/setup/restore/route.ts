import { appContext } from '../../../../server/context.ts';
import { handleSetupRestore } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = (req: Request) => handleSetupRestore(req, appContext());
