/**
 * 절사평균: 활성 멤버 기준 최고·최저 각 1명을 제외한 산술평균.
 * 휴직자는 호출 전에 이미 제외된 값만 넘긴다.
 * 인원이 3명 미만이면 전체가 그대로 평균에 들어간다.
 */
export function getTrimmedAverage(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  if (values.length < 3) {
    return Math.round(
      values.reduce((sum, value) => sum + value, 0) / values.length,
    );
  }

  const sorted = [...values].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, -1);
  const total = trimmed.reduce((sum, value) => sum + value, 0);

  return Math.round(total / trimmed.length);
}
