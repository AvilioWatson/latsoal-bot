export function questionCount(question = {}) {
  const group = Array.isArray(question?.question_group) ? question.question_group : [];
  return Math.max(1, group.length || 1);
}

export function metadataQuestionCount(metadata = {}) {
  return questionCount(metadata?.question || {});
}
