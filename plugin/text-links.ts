const bindingFields: Record<string, string[]> = {
  fontName: ['fontFamily', 'fontStyle', 'fontWeight'], fontSize: ['fontSize'],
  lineHeight: ['lineHeight'], letterSpacing: ['letterSpacing'], fills: ['fills'],
  width: ['width'], height: ['height'], visible: ['visible'],
};
const styleFields = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration'];

// Applied fields must not silently replace an existing text style or variable binding.
export function checkTextPatch(segments: any[], patch: Record<string, unknown>) {
  const fields = Object.keys(patch);
  for (const segment of segments) {
    if (segment.textStyleId && fields.some(key => styleFields.includes(key))) throw new Error('CAPABILITY_UNAVAILABLE');
    if (segment.fillStyleId && fields.includes('fills')) throw new Error('CAPABILITY_UNAVAILABLE');
    const bound = segment.boundVariables ?? {};
    if (fields.some(key => (bindingFields[key] ?? []).some(field => bound[field]))) throw new Error('CAPABILITY_UNAVAILABLE');
    if (fields.includes('fills') && Array.isArray(segment.fills) && segment.fills.some((paint: any) => paint.boundVariables && Object.keys(paint.boundVariables).length)) throw new Error('CAPABILITY_UNAVAILABLE');
  }
}
