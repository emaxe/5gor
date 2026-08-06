#!/usr/bin/env bash

# ============================================================
# 5GOR — Интерактивный скрипт управления проектом
# ============================================================

PORT="${2:-8000}"
PID_FILE=".server.pid"
LOG_FILE=".server.log"

# Цвета для вывода через printf
CLR_RESET="\033[0m"
CLR_BOLD="\033[1m"
CLR_GOLD="\033[38;2;242;193;46m"
CLR_GREEN="\033[38;2;126;231;135m"
CLR_BLUE="\033[38;2;88;166;255m"
CLR_RED="\033[38;2;255;107;107m"
CLR_GRAY="\033[38;2;139;148;158m"

print_header() {
    printf "%b\n" "${CLR_GOLD}"
    printf "========================================================\n"
    printf "   🚕 5GOR — Симулятор таксиста в Пятигорске (CLI)\n"
    printf "========================================================\n"
    printf "%b\n" "${CLR_RESET}"
}

do_build() {
    printf "%bBuilding project with python3 build.py...%b\n" "${CLR_BLUE}${CLR_BOLD}" "${CLR_RESET}"
    if python3 build.py; then
        printf "%b[SUCCESS] Project built successfully!%b\n\n" "${CLR_GREEN}" "${CLR_RESET}"
    else
        printf "%b[ERROR] Build failed!%b\n\n" "${CLR_RED}" "${CLR_RESET}"
        return 1
    fi
}

do_start() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        printf "%b[WARN] Server is already running (PID: %s, Port: %s)%b\n\n" "${CLR_GOLD}" "$(cat "$PID_FILE")" "$PORT"
        return 0
    fi

    printf "%bStarting local HTTP server on port %s...%b\n" "${CLR_BLUE}" "$PORT" "${CLR_RESET}"
    python3 -m http.server "$PORT" > "$LOG_FILE" 2>&1 &
    PID=$!
    echo "$PID" > "$PID_FILE"
    sleep 0.5

    if kill -0 "$PID" 2>/dev/null; then
        printf "%b[SUCCESS] Server started! (PID: %s)%b\n" "${CLR_GREEN}" "$PID" "${CLR_RESET}"
        printf "%bURL: http://localhost:%s%b\n\n" "${CLR_GOLD}${CLR_BOLD}" "$PORT" "${CLR_RESET}"
    else
        printf "%b[ERROR] Failed to start server! Check %s%b\n\n" "${CLR_RED}" "$LOG_FILE" "${CLR_RESET}"
        rm -f "$PID_FILE"
        return 1
    fi
}

do_stop() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID" 2>/dev/null
            printf "%b[SUCCESS] Stopped server (PID: %s)%b\n\n" "${CLR_GREEN}" "$PID" "${CLR_RESET}"
        else
            printf "%b[INFO] Server process not found.%b\n\n" "${CLR_GRAY}" "${CLR_RESET}"
        fi
        rm -f "$PID_FILE"
    else
        printf "%b[INFO] Server is not running.%b\n\n" "${CLR_GRAY}" "${CLR_RESET}"
    fi
}

do_status() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        PID=$(cat "$PID_FILE")
        printf "%b[STATUS] Server is RUNNING (PID: %s)%b\n\n" "${CLR_GREEN}${CLR_BOLD}" "$PID" "${CLR_RESET}"
    else
        printf "%b[STATUS] Server is STOPPED%b\n\n" "${CLR_GRAY}" "${CLR_RESET}"
    fi
}

do_open() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        printf "%bOpening http://localhost:%s in browser...%b\n\n" "${CLR_BLUE}" "$PORT" "${CLR_RESET}"
        open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null || true
    else
        printf "%bOpening index.html directly in browser...%b\n\n" "${CLR_BLUE}" "${CLR_RESET}"
        open index.html 2>/dev/null || xdg-open index.html 2>/dev/null || true
    fi
}

interactive_menu() {
    while true; do
        print_header
        printf "%bДоступные действия:%b\n" "${CLR_BOLD}" "${CLR_RESET}"
        printf "  %b1)%b 🚀 Запустить локальный сервер\n" "${CLR_GOLD}" "${CLR_RESET}"
        printf "  %b2)%b 🛠 Собрать проект (build.py)\n" "${CLR_GOLD}" "${CLR_RESET}"
        printf "  %b3)%b 🌐 Открыть в браузере\n" "${CLR_GOLD}" "${CLR_RESET}"
        printf "  %b4)%b ⚡ Собрать, запустить и открыть\n" "${CLR_GOLD}" "${CLR_RESET}"
        printf "  %b5)%b ⏹ Остановить сервер\n" "${CLR_GOLD}" "${CLR_RESET}"
        printf "  %b6)%b 📊 Статус сервера\n" "${CLR_GOLD}" "${CLR_RESET}"
        printf "  %b0)%b ❌ Выход\n\n" "${CLR_GRAY}" "${CLR_RESET}"

        printf "%bВыберите пункт (0-6): %b" "${CLR_BLUE}" "${CLR_RESET}"
        read -r choice
        printf "\n"

        case "$choice" in
            1) do_start ;;
            2) do_build ;;
            3) do_open ;;
            4) do_build && do_start && do_open ;;
            5) do_stop ;;
            6) do_status ;;
            0) printf "%bДо свидания!%b\n" "${CLR_GRAY}" "${CLR_RESET}"; exit 0 ;;
            *) printf "%b[ERROR] Неверный выбор!%b\n\n" "${CLR_RED}" "${CLR_RESET}" ;;
        esac
    done
}

# Обработка параметров командной строки
case "$1" in
    build) do_build ;;
    start) do_start ;;
    stop)  do_stop ;;
    status) do_status ;;
    open)  do_open ;;
    dev)   do_build && do_start && do_open ;;
    *)     interactive_menu ;;
esac
