// Carry the HTTP status independently of redacted diagnostic text.
export class AttachmentHttpError extends Error {
    constructor(public readonly status: number, message: string) {
        super(message);
        this.name = "AttachmentHttpError";
    }
}
