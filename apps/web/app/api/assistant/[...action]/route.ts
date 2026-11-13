import { appContext } from '../../../../server/context.ts';
import { handleAssistantAction } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const POST = async (req: Request, { params }: { params: Promise<{ action: string[] }> }) =>
  handleAssistantAction(req, appContext(), (await params).action.join('/'));
