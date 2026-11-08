// 사용자에게 그대로 보여 줘도 되는 오류.
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// 파이프라인에서 발생하는, 사용자가 조치할 수 있는 오류(키 없음, 한도 초과 등).
export class UserError extends Error {}
