import builtins
import json
import re
from os.path import join
from urllib.parse import urlencode, urlparse, urlunparse, parse_qs

import requests

from utils.main_service import main_service
from utils.structs import BaseElement, BaseService
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename


class wittytv_it(BaseService):
    DEMO_URLS = [
        "https://www.wittytv.it/?trasmissioni=cat-originals&category_name=google-bar",
        "https://www.wittytv.it/?trasmissioni=cat-amici&category_name=clip",
        "https://www.wittytv.it/?trasmissioni=cat-amici&category_name=le-puntate",
        "https://www.wittytv.it/tu-si-que-vales/prima-puntata-sabato-18-settembre/",
        "https://www.wittytv.it/ce-posta-per-te/quarta-puntata-sabato-3-febbraio/",
        "https://www.wittytv.it/maurizio-costanzo-show/ultima-puntata-venerdi-25-novembre/",
        "https://www.wittytv.it/uomini-e-donne/lunedi-11-marzo-2",
        "https://www.wittytv.it/uomini-e-donne/venerdi-8-marzo-2/",
        "https://www.wittytv.it/uomini-e-donne/esterna-di-ida-e-pierpaolo-8-marzo/",
    ]

    LOGIN_URL = "https://api-ott-prod-fe.mediaset.net/PROD/play/idm/anonymous/login/v2.0"
    ACCOUNT_URL = "http://access.auth.theplatform.com/data/Account/{a_id}"
    PLAYBACK_URL = 'https://api-ott-prod-fe.mediaset.net/PROD/play/playback/check/v2.0'
    PROGRAM_URL = 'https://feed.entertainment.tv.theplatform.eu/f/-/mediaset-prod-ext-programs-v2/guid/-/{guid}'
    QUERY_URL = 'https://www.wittytv.it/wp-admin/admin-ajax.php?action=load_more&query[category_name]={category_name}&query[trasmissioni]={broadcast}&query[paged]={page}'
    MEDIASET_URL = 'https://mediasetinfinity.mediaset.it'
    LICENSE_URL = 'https://widevine.entitlement.theplatform.eu/wv/web/ModularDrm/getRawWidevineLicense'

    USER_AGENT = None
    BEARER_TOKEN = None
    RES_PRIORITY = ["hd", "hr", "sd"]

    @staticmethod
    def test_service():
        main_service.run_service(wittytv_it)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_bearer_token():
        return json.loads(requests.post(
            wittytv_it.LOGIN_URL, json={'client_id': 'client_id', 'appName': 'embed//mediasetplay-embed'}
        ).content.decode())["response"]["beToken"]

    @staticmethod
    def initialize_service():
        if wittytv_it.USER_AGENT is None:
            wittytv_it.USER_AGENT = builtins.CONFIG["USER_AGENT"]
        if wittytv_it.BEARER_TOKEN is None:
            wittytv_it.BEARER_TOKEN = wittytv_it.get_bearer_token()
        return wittytv_it

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            wittytv_it.LICENSE_URL, data=challenge,
            params={
                'releasePid': additional['release_pid'],
                'account': wittytv_it.ACCOUNT_URL.format(a_id=additional["account"]),
                'schema': '1.0', 'token': wittytv_it.BEARER_TOKEN
            }
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_manifest_info(manifest, formats, manifest_info):
        try:
            raise
            return manifest, str(min(re.findall(
                r'<cenc:pssh>(.+?)</cenc:pssh>',
                requests.get(f"{manifest}?formats={formats}").content.decode()
            ), key=len))
        except:
            pass
        matches = re.findall(r'<video\s*src="([^"]+)"', manifest_info)
        manifest = [m for m in matches if ".mpd" in m][0]

        parsed_url = urlparse(manifest)
        path_components = parsed_url.path.split("/")
        manifest_name = path_components[-1]
        name_splits = manifest_name.split("_")

        for res in wittytv_it.RES_PRIORITY:
            temp_splits = name_splits
            temp_splits[0] = res
            manifest_name = "_".join(temp_splits)

            path_components[-1] = manifest_name
            updated_path = "/".join(path_components)
            temp_url = urlunparse((
                parsed_url.scheme, parsed_url.netloc, updated_path,
                parsed_url.params, parsed_url.query, parsed_url.fragment
            ))

            try:
                response = requests.get(f"{temp_url}?formats={formats}")
                if response.status_code < 200 or response.status_code >= 300:
                    raise
            except:
                continue
            try:
                return temp_url, str(min(re.findall(
                    r'<cenc:pssh>(.+?)</cenc:pssh>', response.content.decode()
                ), key=len))
            except:
                return temp_url, None
        return None, None

    @staticmethod
    def get_video_data(source_element):
        content_id = re.search(
            r'guIDcurrentGlobal\s*=\s*"([^"]+)"',
            requests.get(source_element.url).content.decode()
        ).group(1)

        if source_element.element is None:
            content_info = json.loads(requests.get(
                wittytv_it.PROGRAM_URL.format(guid=content_id),
                headers={'User-Agent': wittytv_it.USER_AGENT}
            ).content.decode())

            title = content_info.get("title", None)
            if title is None:
                title = content_id
            title = get_valid_filename(title)

            program = content_info.get("mediasetprogram$brandTitle", None)
            if program is None:
                program = content_info.get("mediasetprogram$auditelBrandName", None)
            if program is None:
                program = content_info.get("mediasetprogram$tvLinearSeasonTitle", None)
            program = get_valid_filename(program)
            if program is None:
                program = ""
            source_element.element = f'{program}_{title}'
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                wittytv_it.__name__
            )

        response = json.loads(requests.post(
            wittytv_it.PLAYBACK_URL, json={'contentId': content_id, 'streamType': 'VOD'},
            headers={
                'User-Agent': wittytv_it.USER_AGENT,
                'Authorization': f'Bearer {wittytv_it.BEARER_TOKEN}'
            }
        ).content.decode())["response"]["mediaSelector"]

        manifest = response.pop("url")
        response["auth"] = wittytv_it.BEARER_TOKEN
        manifest_info = f"{manifest}?{urlencode(response)}"
        manifest_info = requests.get(manifest_info, headers={
            'Accept': 'application/json, text/plain, */*',
            'Origin': wittytv_it.MEDIASET_URL,
            'Referer': wittytv_it.MEDIASET_URL,
            'User-Agent': wittytv_it.USER_AGENT
        }).content.decode()

        manifest, pssh_value = wittytv_it.get_manifest_info(manifest, response["formats"], manifest_info)
        return manifest, pssh_value, {
            "release_pid": re.search(r"\|pid=(.*?)\|", manifest_info).group(1),
            "account": re.search(r"aid=(.*?)\|", manifest_info).group(1)
        }

    @staticmethod
    def get_collection_elements(collection_url):
        if "trasmissioni=" in collection_url and "category_name=" in collection_url:
            collection = []
            params_dict = parse_qs(urlparse(collection_url).query)
            broadcast = params_dict["trasmissioni"][0]
            category_name = params_dict["category_name"][0]
            collection_name = get_valid_filename(broadcast)

            page = 0
            episode_index = 0
            urls = []
            while True:
                page += 1
                episodes = json.loads(requests.get(wittytv_it.QUERY_URL.format(
                    category_name=category_name,
                    broadcast=broadcast,
                    page=str(page)
                )).content.decode())["data"]
                if len(episodes) == 0:
                    break

                for episode in episodes:
                    if episode["link"] in urls:
                        continue

                    episode_index += 1
                    check = check_range(False, None, episode_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    collection.append(BaseElement(
                        url=episode["link"],
                        collection=join(join(
                            str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                            wittytv_it.__name__
                        ), collection_name),
                        element=f'{episode_index}_{get_valid_filename(episode["title"])}'
                    ))
                    urls.append(episode["link"])
            return collection

        if collection_url.split("wittytv.it")[1].count("/") >= 2:
            return [BaseElement(url=collection_url)]
        return None
