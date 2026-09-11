// Plaintext validation shared by the session and the view. A sender name is
// one trimmed line without control characters; message text is any string
// without lone surrogates. Lengths are bounded by the server's ciphertext caps.
const trimSpace = s => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
function validString(s){ return typeof s === 'string' && !/\p{Cs}/u.test(s); }
function validFrom(s){ return validString(s) && s !== '' && trimSpace(s) === s && !/\p{Cc}/u.test(s); }
const NAME_RULE = 'Name must be a single trimmed line without control characters.';
