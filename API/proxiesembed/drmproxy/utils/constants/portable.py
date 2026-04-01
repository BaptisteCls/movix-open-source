import os
import platform
import shutil
import subprocess
from functools import partial

SUPPORTED_OS = ['windows', 'linux', 'darwin']
SUPPORTED_ARCHITECTURES = ['64bit']
CURRENT_OS = platform.system().lower()
CURRENT_ARCHITECTURE = platform.architecture()[0].lower()
IS_SUPPORTED_OS = CURRENT_OS in SUPPORTED_OS and 'ANDROID_ARGUMENT' not in os.environ
IS_SUPPORTED_SYSTEM = IS_SUPPORTED_OS and CURRENT_ARCHITECTURE in SUPPORTED_ARCHITECTURES

SUPPORTED_LINUX_TERMINALS = [
    "gnome-terminal --wait -- {shell} -c '{command}'",
    "xterm -e {shell} -c '{command}'", "konsole -e {shell} -c '{command}'",
    "urxvt -e {shell} -c '{command}'", "alacritty -e {shell} -c '{command}'"
]
SUPPORTED_LINUX_SHELLS = [
    "bash", "sh", "zsh", "dash", "ksh", "fish",
    "tcsh", "csh", "ash", "mksh", "sash"
]


class EnvironmentConstants:
    _initialized = False
    IS_SUPPORTED = None
    TERMINAL_CHOSEN = ""
    SHELL_CHOSEN = ""
    ERROR_MESSAGE = ""
    INFO_MESSAGE = ""

    @staticmethod
    def initialize_once():
        if EnvironmentConstants._initialized is True:
            return
        EnvironmentConstants._initialized = True
        if not IS_SUPPORTED_SYSTEM:
            EnvironmentConstants.IS_SUPPORTED = False
            return

        if CURRENT_OS == "linux":
            for terminal in SUPPORTED_LINUX_TERMINALS:
                if shutil.which(terminal.split(" ")[0]):
                    EnvironmentConstants.TERMINAL_CHOSEN = terminal
                    break
            for shell in SUPPORTED_LINUX_SHELLS:
                if shutil.which(shell):
                    EnvironmentConstants.SHELL_CHOSEN = shell
                    break

            EnvironmentConstants.IS_SUPPORTED = (
                    len(EnvironmentConstants.TERMINAL_CHOSEN) > 0 and
                    len(EnvironmentConstants.SHELL_CHOSEN) > 0
            )
            if EnvironmentConstants.TERMINAL_CHOSEN == "":
                EnvironmentConstants.ERROR_MESSAGE = (
                    f"The Linux system doesn't use any of the supported Linux terminals: "
                    f"{str([s.split(' ')[0] for s in SUPPORTED_LINUX_TERMINALS])}. Install one of them."
                )
            elif EnvironmentConstants.SHELL_CHOSEN == "":
                EnvironmentConstants.ERROR_MESSAGE = (
                    f"The Linux system doesn't use any of the supported Linux shells: "
                    f"{str(SUPPORTED_LINUX_SHELLS)}. Install one of them."
                )
            else:
                EnvironmentConstants.INFO_MESSAGE = (
                    f"Linux detected. Chosen terminal: {EnvironmentConstants.TERMINAL_CHOSEN.split(' ')[0]}. "
                    f"Chosen shell: {EnvironmentConstants.SHELL_CHOSEN}."
                )

        elif CURRENT_OS == "darwin":
            EnvironmentConstants.IS_SUPPORTED = False
            EnvironmentConstants.ERROR_MESSAGE = "MacOS detected."

        else:  # elif CURRENT_OS == "windows":
            EnvironmentConstants.IS_SUPPORTED = True


CMD_JOIN = ";"
CMD_JOIN_ADJUST = "\\"
CMD_DELETE = 'rm -rf'
CMD_SCRIPT_EXT = 'sh'
IS_FILE_EXECUTABLE = lambda s: os.access(s, os.X_OK)
TERMINAL_CLOSE = 'exit'

EnvironmentConstants.initialize_once()

if CURRENT_OS == "linux":
    terminal_open = partial(
        EnvironmentConstants.TERMINAL_CHOSEN.format,
        shell=EnvironmentConstants.SHELL_CHOSEN
    )
    cmd_adjust = lambda cmd_input: cmd_input.replace('"', '\\"') \
        if '"' in terminal_open(command="") and "'" in terminal_open(command="") else cmd_input
    TERMINAL_LAUNCH = lambda cmd_input: \
        subprocess.check_output(terminal_open(command=cmd_adjust(cmd_input)), shell=True)

elif CURRENT_OS == "darwin":
    TERMINAL_LAUNCH = None

else:  # elif CURRENT_OS == "windows":
    CMD_JOIN = "&"
    CMD_JOIN_ADJUST = "^"
    CMD_DELETE = 'rd /s /q'
    CMD_SCRIPT_EXT = 'bat'
    IS_FILE_EXECUTABLE = lambda s: True

    terminal_open = partial('start /wait cmd /k "{command}"'.format)
    TERMINAL_LAUNCH = lambda cmd_input: \
        subprocess.check_output(terminal_open(command=cmd_input), shell=True)

CMD_ADJUST = CMD_JOIN_ADJUST
CMD_JOIN_ADJUST = f'{CMD_JOIN_ADJUST}{CMD_JOIN}'
