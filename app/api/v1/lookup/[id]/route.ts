import { handlePoll } from '../../../../../lib/http/lookupHandler';

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  return handlePoll(request, context);
}
