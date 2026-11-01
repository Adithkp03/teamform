export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errors = {
  unauthorized: () => new ApiError(401, 'unauthorized', 'Authentication required'),
  forbidden: (m = 'Not allowed') => new ApiError(403, 'forbidden', m),
  notFound: (m = 'Not found') => new ApiError(404, 'not_found', m),
  conflict: (code: string, m: string) => new ApiError(409, code, m),
  gone: (m: string) => new ApiError(410, 'gone', m),
  tooMany: (m = 'Rate limit exceeded, slow down') => new ApiError(429, 'rate_limited', m),
  badRequest: (m: string) => new ApiError(400, 'bad_request', m),
};
