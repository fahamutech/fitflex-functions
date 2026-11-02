// What stands in for someone who deleted their FitFlex account (owner decision 2026-10-30).
//
// Kept financial and access records have no person behind them any more. API fields that carry a name
// are null, or `forgotten: true`, and clients show their own translated "Deleted member". This label is
// for the places where the server itself writes the name into a row or a line of text: it is one
// string, so it carries both languages.
export const DELETED_PERSON_LABEL = 'Deleted member / Mwanachama aliyefutwa';

// EventRegistration needs a first and a last name (1-80 characters); together they read as the label.
export const DELETED_PERSON_FIRST_NAME = 'Deleted member /';
export const DELETED_PERSON_LAST_NAME = 'Mwanachama aliyefutwa';
