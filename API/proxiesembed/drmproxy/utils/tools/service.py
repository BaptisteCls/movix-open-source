import builtins
import importlib
import os

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR, CONFIG_FILE, APP_DIR, WARN_MSG
from utils.structs import CustomException
from utils.tools.common import get_base_url


def get_all_services_classes():
    import services
    py_files = []
    for py_file in os.listdir(os.path.dirname(services.__file__)):
        if not py_file.endswith(".py") or py_file == "__init__.py":
            continue

        py_file = py_file[:-3]
        try:
            py_files.append(getattr(importlib.import_module(f"services.{py_file}"), py_file))
        except Exception as e:
            try:
                check_debug = builtins.CONFIG["DEBUG_MODE"]
            except:
                check_debug = False
            if check_debug:
                raise e

            service_name = py_file.replace('_', '.')
            if service_name.startswith("."):
                service_name = service_name[1:]

            print(WARN_MSG.format(
                msg=f"The service {service_name} cannot be used because "
                    f"it is not properly implemented, has package errors or has syntax errors. After fixing the issue "
                    f"delete the {APP_DIR} folder."
            ))
    return py_files


def get_service(content_url):
    base_url = get_base_url(content_url)
    service = builtins.SERVICES.get(base_url, None)
    if service is None:
        print(ERR_MSG.format(
            type=USER_ERROR,
            url=content_url,
            reason=f"No service available for {base_url}",
            solution=f"Implement it"
        ))
        return None

    try:
        service_name = service.__name__
        service = service.initialize_service()
        if service is None:
            print(ERR_MSG.format(
                type=f'{USER_ERROR}/{APP_ERROR}',
                url=content_url,
                reason=f"Failed to initialize the {service_name} service",
                solution=f"Check the service credentials in the {CONFIG_FILE} file. "
                         f"If you are sure everything is right then debug the service"
            ))
        return service
    except CustomException as e:
        if builtins.CONFIG["DEBUG_MODE"]:
            raise e
        print(str(e))
    except Exception as e:
        if builtins.CONFIG["DEBUG_MODE"]:
            raise e
        print(ERR_MSG.format(
            type=APP_ERROR,
            url=content_url,
            reason=f"Failed to initialize the {service.__name__} service",
            solution=f"Debug the service"
        ))
    return None


def get_all_services():
    services = {}
    for py_file in get_all_services_classes():
        name = py_file.__name__.replace("_", ".")
        if name[0] == ".":
            name = name[1:]
        services[name] = py_file
    return services
