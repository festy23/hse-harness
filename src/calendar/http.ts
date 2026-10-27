import { OperationError } from '../operations.js';

export const MAX_CALENDAR_BYTES = 8 * 1024 * 1024;

export function limitedResponse(response: Response, maxBytes = MAX_CALENDAR_BYTES): Response {
  if (!response.body) {
    return response;
  }
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          controller.close();
          return;
        }
        bytes += part.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new OperationError('payload-limit', 'Ответ календаря превышает допустимый размер');
        }
        controller.enqueue(part.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
