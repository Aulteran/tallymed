import { appContext } from '../../../../../server/context.ts';
import { handleDocumentDownload } from '../../../../../server/http.ts';

export const dynamic = 'force-dynamic';
export const GET = async (req: Request, { params }: { params: Promise<{ id: string }> }) =>
  handleDocumentDownload(req, appContext(), (await params).id);
