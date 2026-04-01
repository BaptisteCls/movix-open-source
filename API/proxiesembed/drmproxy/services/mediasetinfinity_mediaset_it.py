import builtins
import json
import re
from os.path import join
from urllib.parse import urlencode, urlparse, urlunparse

import requests

from utils.constants.macros import USER_ERROR, ERR_MSG, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename


class mediasetinfinity_mediaset_it(BaseService):
    DEMO_URLS = [
        "https://mediasetinfinity.mediaset.it/video/yogaradiobrunoestate/prima-puntata_F313369801000101",
        "https://mediasetinfinity.mediaset.it/programmi-tv/studioaperto/edizioniintegrali_SE000000000053,ST000000000132,sb9890596",
        "https://mediasetinfinity.mediaset.it/browse/regione-piemonte_e6538f0b2a0e845001909118d",
        "https://mediasetinfinity.mediaset.it/video/ierieoggiintv/popcorn-1983_F308773901011401",
        "https://mediasetinfinity.mediaset.it/video/bravo/siamo-gia-il-tuo-futuro-bravo-e-anche-il-tuo-mondo_FD00000000323805",
    ]

    LOGIN_URL = "https://api-ott-prod-fe.mediaset.net/PROD/play/idm/anonymous/login/v2.0"
    ACCOUNT_URL = "http://access.auth.theplatform.com/data/Account/{a_id}"
    PLAYBACK_URL = 'https://api-ott-prod-fe.mediaset.net/PROD/play/playback/check/v2.0'
    PROGRAM_URL = 'https://feed.entertainment.tv.theplatform.eu/f/-/mediaset-prod-ext-programs-v2/guid/-/{guid}'
    BASE_URL = 'https://mediasetinfinity.mediaset.it'
    SPACE_URL = 'https://cdn.contentful.com/spaces/{id}/environments/master/entries'
    PROD_URL = 'https://feed.entertainment.tv.theplatform.eu/f/-/mediaset-prod-all-programs-v2?byCustomValue=%7BsubBrandId%7D%7B{sb}%7D&sort=:publishInfo_lastPublished%7Cdesc,tvSeasonEpisodeNumber%7Casc'
    LICENSE_URL = 'https://widevine.entitlement.theplatform.eu/wv/web/ModularDrm/getRawWidevineLicense'

    USER_AGENT = None
    BEARER_TOKEN = None
    ACCESS_TOKEN = None
    SPACE_ID = None
    PAGE_SIZE = 90
    RES_PRIORITY = ["hd", "hr", "sd"]

    @staticmethod
    def test_service():
        main_service.run_service(mediasetinfinity_mediaset_it)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_bearer_token():
        return json.loads(requests.post(
            mediasetinfinity_mediaset_it.LOGIN_URL,
            json={'client_id': 'client_id', 'appName': 'embed//mediasetplay-embed'}
        ).content.decode())["response"]["beToken"]

    @staticmethod
    def get_basic_info():
        vendor_js = requests.get(re.findall(
            r'href="(http[^\"]*vendor[^\"]*\.js)"',
            requests.get(mediasetinfinity_mediaset_it.BASE_URL).content.decode()
        )[0]).content.decode()

        space_id = re.findall(r'space:"(.*?)"', vendor_js)[0]
        access_token = re.findall(r'accessToken:"(.*?)"', vendor_js)[0]
        return space_id, access_token

    @staticmethod
    def initialize_service():
        if mediasetinfinity_mediaset_it.USER_AGENT is None:
            mediasetinfinity_mediaset_it.USER_AGENT = builtins.CONFIG["USER_AGENT"]
        if mediasetinfinity_mediaset_it.BEARER_TOKEN is None:
            mediasetinfinity_mediaset_it.BEARER_TOKEN = mediasetinfinity_mediaset_it.get_bearer_token()

        if mediasetinfinity_mediaset_it.SPACE_ID is None or mediasetinfinity_mediaset_it.ACCESS_TOKEN is None:
            mediasetinfinity_mediaset_it.SPACE_ID, mediasetinfinity_mediaset_it.ACCESS_TOKEN = \
                mediasetinfinity_mediaset_it.get_basic_info()
        return mediasetinfinity_mediaset_it

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            mediasetinfinity_mediaset_it.LICENSE_URL, data=challenge,
            params={
                'releasePid': additional['release_pid'],
                'account': mediasetinfinity_mediaset_it.ACCOUNT_URL.format(a_id=additional["account"]),
                'schema': '1.0', 'token': mediasetinfinity_mediaset_it.BEARER_TOKEN
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

        for res in mediasetinfinity_mediaset_it.RES_PRIORITY:
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
    def get_content_name(content_info, content_id):
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
        return f'{program}_{title}'

    @staticmethod
    def get_video_data(source_element):
        page_content = requests.get(source_element.url).content.decode()
        try:
            content_id = re.search(
                r'[?&]programGuid=([^"&]+)["&]',
                page_content
            ).group(1)
        except:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content wasn't found",
                solution="Do not attempt to download it"
            ))

        if source_element.element is None:
            content_info = json.loads(requests.get(
                mediasetinfinity_mediaset_it.PROGRAM_URL.format(guid=content_id),
                headers={'User-Agent': mediasetinfinity_mediaset_it.USER_AGENT}
            ).content.decode())

            source_element.element = mediasetinfinity_mediaset_it.get_content_name(content_info, content_id)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                mediasetinfinity_mediaset_it.__name__
            )

        response = json.loads(requests.post(
            mediasetinfinity_mediaset_it.PLAYBACK_URL, json={'contentId': content_id, 'streamType': 'VOD'},
            headers={
                'User-Agent': mediasetinfinity_mediaset_it.USER_AGENT,
                'Authorization': f'Bearer {mediasetinfinity_mediaset_it.BEARER_TOKEN}'
            }
        ).content.decode())
        message = response.get("error", {}).get("message", "").lower()
        if "available" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need Italian IP to access content",
                solution="Use a VPN"
            ))
        if "rights" in message:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Can't download paid content",
                solution='Do not attempt to download it'
            ))
        if len(message) > 0:
            raise CustomException(ERR_MSG.format(
                type=f'{APP_ERROR}',
                url=source_element.url,
                reason=f"Unknown error encountered: {message}",
                solution=f"Debug the {mediasetinfinity_mediaset_it.__name__} service"
            ))

        response = response["response"]["mediaSelector"]
        manifest = response.pop("url")
        response["auth"] = mediasetinfinity_mediaset_it.BEARER_TOKEN

        manifest_info = f"{manifest}?{urlencode(response)}"
        manifest_info = requests.get(manifest_info, headers={
            'Accept': 'application/json, text/plain, */*',
            'Origin': mediasetinfinity_mediaset_it.BASE_URL,
            'Referer': mediasetinfinity_mediaset_it.BASE_URL,
            'User-Agent': mediasetinfinity_mediaset_it.USER_AGENT
        }).content.decode()

        if "AnonymousProxyBlocked" in manifest_info:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The VPN was detected",
                solution="Use a better VPN"
            ))

        manifest, pssh_value = mediasetinfinity_mediaset_it.get_manifest_info(
            manifest, response["formats"], manifest_info
        )
        return manifest, pssh_value, {
            "release_pid": re.search(r"\|pid=(.*?)\|", manifest_info).group(1),
            "account": re.search(r"aid=(.*?)\|", manifest_info).group(1)
        }

    @staticmethod
    def get_feed_elements(collection_name, feed_url):
        collection_name = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                mediasetinfinity_mediaset_it.__name__
            ),
            get_valid_filename(collection_name)
        )
        collection = []

        current_index = 0
        content_index = 0
        urls = []

        while True:
            response = json.loads(requests.get(
                f'{feed_url}&range={current_index}-{current_index + mediasetinfinity_mediaset_it.PAGE_SIZE}',
            ).content.decode())
            if len(response.get("entries", [])) == 0:
                break

            for entry in response["entries"]:
                entry_url = entry["mediasetprogram$videoPageUrl"]
                if not entry_url.startswith("https:"):
                    entry_url = "https:" + entry_url
                if entry_url in urls:
                    continue

                content_index += 1
                check = check_range(False, None, content_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                collection.append(BaseElement(
                    url=entry_url,
                    collection=collection_name,
                    element=f'{content_index}'
                            f'_'
                            f'{mediasetinfinity_mediaset_it.get_content_name(entry, entry["guid"])}'
                ))
                urls.append(entry_url)

            current_index += mediasetinfinity_mediaset_it.PAGE_SIZE + 1
        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.rstrip("/")
        if "/browse/" in collection_url:
            sys_id = collection_url.split("_")[-1][1:]
            response = json.loads(requests.get(
                mediasetinfinity_mediaset_it.SPACE_URL.format(id=mediasetinfinity_mediaset_it.SPACE_ID),
                params={'include': '1', 'sys.id': sys_id},
                headers={'Authorization': f'Bearer {mediasetinfinity_mediaset_it.ACCESS_TOKEN}'}
            ).content.decode())["items"]

            collection_name = collection_url.split("/")[-1].split("_")[0]
            feed_url = None
            for item in response:
                try:
                    if (
                            item["sys"]["id"] != sys_id or
                            item["sys"]["space"]["sys"]["id"] != mediasetinfinity_mediaset_it.SPACE_ID
                    ):
                        continue

                    fields = item["fields"]
                    collection_name = fields.get("name", fields.get("title", collection_name))

                    for k in fields:
                        if k.startswith("feedurl"):
                            feed_url = fields[k]
                            break
                    assert feed_url is not None
                    break
                except:
                    pass

            if feed_url is None:
                return None
            return mediasetinfinity_mediaset_it.get_feed_elements(collection_name, feed_url)

        if ",sb" in collection_url:
            collection_name = collection_url.split("/")[-2]
            sb = None
            for p in collection_url.split(","):
                if p.startswith("sb"):
                    sb = p[2:]

            if sb is None:
                return None
            return mediasetinfinity_mediaset_it.get_feed_elements(
                collection_name,
                mediasetinfinity_mediaset_it.PROD_URL.format(sb=sb)
            )

        if "/video/" in collection_url or "/movie/" in collection_url:
            return [BaseElement(url=collection_url)]
        return None
