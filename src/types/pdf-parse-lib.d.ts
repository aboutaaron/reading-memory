declare module 'pdf-parse/lib/pdf-parse.js' {
  export default function pdfParse(input: Uint8Array, options?: { max?: number }): Promise<{
    text: string;
    numpages: number;
    info?: { Title?: unknown; Author?: unknown } | null;
  }>;
}
