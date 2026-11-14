import { appContext } from '../../../../server/context.ts';
import { handleSettingsAction } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = async (req: Request, { params }: { params: Promise<{ action: string[] }> }) =>
  handleSettingsAction(req, appContext(), (await params).action.join('/'));
