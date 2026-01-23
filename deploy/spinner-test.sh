#!/usr/bin/env bash
set -euo pipefail

run_with_spinner() {
  local label="$1"
  local cmd="$2"
  local spinner='|/-\'
  local i=0
  local out="/dev/null"

  if [[ -w /dev/tty ]]; then
    out="/dev/tty"
  elif [[ -t 2 ]]; then
    out="/dev/stderr"
  fi

  printf "%s ... " "${label}" > "${out}"

  bash -c "${cmd}" >/dev/null 2>&1 &
  local pid=$!

  while kill -0 "${pid}" 2>/dev/null; do
    printf "\r%s ... %c" "${label}" "${spinner:i++%${#spinner}:1}" > "${out}"
    sleep 0.1
  done

  wait "${pid}"
  local status=$?
  if [[ ${status} -eq 0 ]]; then
    printf "\r%s ... done\n" "${label}" > "${out}"
  else
    printf "\r%s ... failed\n" "${label}" > "${out}"
  fi
  return ${status}
}

run_with_spinner "Тест спиннера (5с)" "sleep 5"
run_with_spinner "Тест спиннера (успех)" "sleep 1"
run_with_spinner "Тест спиннера (ошибка)" "exit 1"
