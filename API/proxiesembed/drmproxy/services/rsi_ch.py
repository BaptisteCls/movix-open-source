import builtins
import json
import re
from os.path import join
from urllib.parse import urlparse, parse_qs, quote

import requests

import utils.tools.common as common_tools
from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range


class rsi_ch(BaseService):
    DEMO_URLS = [
        "https://www.rsi.ch/play/ricerca?query=&showAll=true&shows=urn%3Arsi%3Ashow%3Atv%3A704146&topics=urn%3Arsi%3Atopic%3Atv%3A7&from=2024-05-26&to=2024-06-26&duration=shorterThan5Mins",
        "https://www.rsi.ch/play/ricerca?query=test&shows=urn%3Arsi%3Ashow%3Atv%3A704146&topics=urn%3Arsi%3Atopic%3Atv%3A7&duration=shorterThan5Mins",
        "https://www.rsi.ch/play/tv/detail/natura?id=42d6d38a-7b95-4ab3-b198-2300934792b0",
        "https://www.rsi.ch/play/tv/programma/narcos?id=704026",
        "https://www.rsi.ch/play/tv/programma/turbozauros?id=2167444",
        "https://www.rsi.ch/play/tv/programma/la-strategia-dellacqua?id=702315",
        "https://www.rsi.ch/play/tv/programma/hudson-e-rex?id=2138198",
        "https://www.rsi.ch/play/tv/-/video/intervista-a-angelina-mango-altro-che-noia?urn=urn:rsi:video:2177087",
        "https://www.rsi.ch/play/tv/-/video/euro-2024-la-rete-dell1-1-di-mattia-zaccagni-in-croazia-italia-24-06-2024?urn=urn:rsi:video:2186168",
    ]

    PRODUCTION_URL = 'https://www.rsi.ch/play/v3/api/rsi/production/{production_type}'
    URN_URL = 'https://il.srgssr.ch/integrationlayer/2.0/mediaComposition/byUrn/{urn}.json'
    TOKEN_URL = 'https://tp.srgssr.ch/akahd/token'
    BASE_URL = "https://www.rsi.ch"

    RES_PRIORITY = {"sd": 0, "hd": 1}
    PUBLIC_IP = None
    PROD_TYPES = ["media-section", "media-section-with-show"]

    @staticmethod
    def test_service():
        main_service.run_service(rsi_ch)

    @staticmethod
    def get_additional_params(additional):
        return [
            ("HEADER", lambda s: s.format(key="X-Forwarded-For", value=rsi_ch.PUBLIC_IP)),
            ("MUXER", lambda s: s.format(args="mkv:muxer=mkvmerge"))
        ]

    @staticmethod
    def is_content_livestream(content, additional):
        return additional.get("LIVE", False)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        if rsi_ch.PUBLIC_IP is None:
            if builtins.CONFIG.get("BASIC", False) is True:
                rsi_ch.PUBLIC_IP = "<IP>"
            else:
                rsi_ch.PUBLIC_IP = common_tools.get_public_ip()
            if rsi_ch.PUBLIC_IP is None:
                raise CustomException(ERR_MSG.format(
                    type=f'{APP_ERROR}',
                    url=f'from the {rsi_ch.__name__} service',
                    reason="Failed to obtain the public IP",
                    solution="Fix the code responsible for obtaining the IP"
                ))

        return rsi_ch

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(additional["license_url"], data=challenge)
        status_code = licence.status_code
        try:
            assert status_code < 200 or 300 <= status_code
            message = json.loads(licence.content.decode())["message"].lower()
            assert len(message) > 0 and type(message) is str
        except:
            message = ""

        if status_code in [403] or "not available" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=additional["content_url"],
                reason="Need Swiss IP to make license call",
                solution="Use a VPN (that is not detected)"
            ))
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        urn = parse_qs(urlparse(source_element.url).query)["urn"][0]
        response = requests.get(rsi_ch.URN_URL.format(urn=urn))
        status_code = response.status_code
        response = json.loads(response.content.decode())
        message = response.get("status", {})

        if status_code == 404 or message.get("code") == 404 or "not found" in message.get("msg", "").lower():
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        if source_element.element is None:
            titles = []
            for k in ["channel", "show", "episode"]:
                if response.get(k, None) not in [None, {}]:
                    if response[k].get("title", None) not in [None, ""]:
                        titles.append(response[k]["title"])
            if len(titles) == 0:
                video_title = source_element.url.split("?")[0].split("/")[-1]
            else:
                video_title = "_".join(titles)

            source_element.element = common_tools.get_valid_filename(video_title)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                rsi_ch.__name__
            )

        chapter = list(filter(lambda c: c["urn"] == urn, response.get("chapterList", [])))
        if len(chapter) > 0:
            chapter = chapter[0]
        else:
            chapter = response.get("chapterList", [])[0]

        resources = chapter.get("resourceList", [])
        resources = list(filter(lambda r: r['protocol'].lower() in ['hls', 'mpd', 'ism', 'dash'], resources))
        resources = sorted(resources, key=lambda r: rsi_ch.RES_PRIORITY[r["quality"].lower()], reverse=True)
        if len(resources) == 0:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need Swiss IP to access content",
                solution="Use a VPN (that is not detected)"
            ))

        content_resource = None
        license_url = None
        for resource in resources:
            drm_list = resource.get("drmList", None)
            is_drm = drm_list not in ["", None, []] and type(drm_list) is list

            if is_drm:
                for drm in drm_list:
                    if drm.get("type", "").lower() == "widevine":
                        content_resource = resource
                        license_url = drm["licenseUrl"]
                        break
            else:
                content_resource = resource
            if content_resource is not None:
                break

        if content_resource is None:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason=f"DRM not supported. Widevine wasn't found",
                solution="Do not attempt to download it"
            ))

        resource = content_resource
        manifest = resource["url"]
        acl = manifest.split("//")[1].split("?")[0]
        acl = re.search(r"(/.+/)", acl).group(1) + "*"
        response = json.loads(requests.get(rsi_ch.TOKEN_URL, params={"acl": acl}).content.decode())
        if "?" not in manifest:
            manifest += "?"
        else:
            manifest += "&"

        auth_params = response["token"]["authparams"].split("&")
        temp_params = {}
        for p in auth_params:
            index = p.index("=")
            temp_params[p[0:index]] = quote(p[index + 1:], safe='')
        auth_params = '&'.join([
            f'{k}={v}' for k, v in temp_params.items()
        ]).replace("~", "%7E")

        manifest += auth_params
        manifest_content = requests.get(manifest).content.decode()
        if ">access denied<" in manifest_content.lower():
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need Swiss IP to access content",
                solution="Use a VPN"
            ))

        pssh_values = None
        additional = {"LIVE": resource.get("live", False), "content_url": source_element.url}
        if license_url is not None:
            values = re.findall(
                r'>(AAAA[^<>]+)</cenc:pssh>',
                manifest_content
            )
            pssh_values = []
            for p in values:
                if p in pssh_values:
                    continue
                pssh_values.append(p)
                additional[p] = {"license_url": license_url, "content_url": source_element.url}

            if len(pssh_values) == 0:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}",
                    solution=f"Extend the {rsi_ch.__name__} service"
                ))

        return manifest, pssh_values, additional

    @staticmethod
    def get_handler_series(collection_url):
        collection = []
        collection_name = None
        content_id = parse_qs(urlparse(collection_url).query)["id"][0]

        response = [{"id": content_id}]
        if "/detail/" not in collection_url:
            try:
                response = json.loads(re.findall(
                    r'__remixContext[^{}]*({.*?})[^{}]*</script>',
                    requests.get(collection_url).content.decode(),
                    re.MULTILINE
                )[0])["state"]["loaderData"]["show"]["show"]["urn"]
            except:
                response = f'urn:rsi:show:tv:{content_id}'

            response = requests.get(
                rsi_ch.PRODUCTION_URL.format(production_type='show-page'),
                params={'showUrn': response, 'preview': 'false'}
            )
            response = response.content.decode()
            response = json.loads(response).get("data", {}).get("sections", [])
        else:
            collection_name = collection_url.split("?")[0].split("/")[-1]
            collection_name = join(
                join(
                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                    rsi_ch.__name__
                ),
                common_tools.get_valid_filename(collection_name)
            )

        if len(response) == 0:
            return collection

        section_index = 0
        sections = response
        visited = []
        flag_all = False

        for section in sections:
            if section["id"] in visited:
                continue
            visited.append(section["id"])
            section_index += 1

            check = check_range(True, section_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            section_name = f'Section_{section_index}'
            if section.get("representation", {}) not in [None, {}]:
                if section["representation"].get("title", "") not in ["", None]:
                    section_name += "_" + section["representation"]["title"]
            section_name = common_tools.get_valid_filename(section_name)

            section_type = section.get("sectionType", "MediaSection")
            prod_type = rsi_ch.PROD_TYPES[0]

            if section_type == "MediaSection":
                for p in rsi_ch.PROD_TYPES:
                    response = requests.get(
                        rsi_ch.PRODUCTION_URL.format(production_type=p),
                        params={'sectionId': section["id"], 'preview': 'false'}
                    )
                    if 200 <= response.status_code < 300:
                        prod_type = p
                        break
            else:
                if flag_all:
                    continue
                flag_all = True
                response = requests.get(
                    rsi_ch.PRODUCTION_URL.format(production_type="videos-by-show-id"),
                    params={'showId': content_id}
                )

            video_index = 0
            while True:
                response = json.loads(response.content.decode()).get("data", {})
                if type(response) is not dict:
                    break
                videos = response.get("data", [])
                if len(videos) == 0:
                    videos = response.get("medias", [])
                if len(videos) == 0:
                    break

                for video in videos:
                    if collection_name is None:
                        titles = []
                        for k in ["channel", "show"]:
                            if video.get(k, None) not in [None, {}]:
                                if video[k].get("title", None) not in [None, ""]:
                                    titles.append(video[k]["title"])

                        collection_name = join(
                            join(
                                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                rsi_ch.__name__
                            ),
                            common_tools.get_valid_filename("_".join(titles))
                        )

                    if video["urn"] in visited:
                        continue
                    visited.append(video["urn"])

                    video_index += 1
                    check = check_range(False, section_index, video_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    video_title = common_tools.get_valid_filename(video["title"])
                    video_url = collection_url.split("?")[0].replace("/programma/", "/")
                    video_url += "/video/" + video_title.replace("_", "-").lower()
                    video_url += "?urn=" + video["urn"]

                    collection.append(BaseElement(
                        url=video_url,
                        collection=join(collection_name, section_name),
                        element=f'Video_{video_index}_{video_title}'
                    ))

                next_page = response.get("next", None)
                if next_page is None:
                    break

                if section_type == "MediaSection":
                    response = requests.get(
                        rsi_ch.PRODUCTION_URL.format(production_type=prod_type),
                        params={'sectionId': section["id"], 'next': next_page, 'preview': 'false'}
                    )
                else:
                    response = requests.get(
                        rsi_ch.PRODUCTION_URL.format(production_type="videos-by-show-id"),
                        params={'showId': content_id, 'next': next_page}
                    )

        return collection

    @staticmethod
    def get_handler_search(collection_url):
        collection = []
        collection_name = "Search_" + common_tools.rand_str(4)

        params = parse_qs(urlparse(collection_url).query)
        temp_params = {'includeAggregations': 'false', 'mediaType': 'VIDEO'}
        for k, v in params.items():
            collection_name += "_" + k + "_" + v[0]
            temp_params[k] = v[0]
        collection_name = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                rsi_ch.__name__
            ),
            common_tools.get_valid_filename(collection_name[0:60])
        )
        params = temp_params

        if "query" in params.keys():
            params["searchTerm"] = params["query"]
            del params["query"]

        visited = []
        response = requests.get(
            rsi_ch.PRODUCTION_URL.format(production_type="search/media"),
            params=params
        )

        video_index = 0
        while True:
            response = json.loads(response.content.decode()).get("data", {})
            if type(response) is not dict:
                break
            videos = response.get("results", [])
            if len(videos) == 0:
                break

            for video in videos:
                if video["urn"] in visited:
                    continue
                visited.append(video["urn"])

                video_index += 1
                check = check_range(False, None, video_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                video_url = rsi_ch.BASE_URL + "/play/"
                video_url += video["show"].get("transmission", video["show"]["urn"].split(":")[-2]).lower()
                video_url += "/" + common_tools.get_valid_filename(video["show"]["title"]).lower().replace("_", "-")

                video_title = common_tools.get_valid_filename(video["title"])
                video_url += "/video/" + video_title.replace("_", "-").lower()
                video_url += "?urn=" + video["urn"]

                collection.append(BaseElement(
                    url=video_url,
                    collection=collection_name,
                    element=f'Video_{video_index}_{video_title}'
                ))

            next_page = response.get("next", None)
            if next_page is None:
                break

            params["next"] = next_page
            response = requests.get(
                rsi_ch.PRODUCTION_URL.format(production_type="search/media"),
                params=params
            )

        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        if (rsi_ch.BASE_URL + "/play/") not in collection_url:
            return None
        collection_url = collection_url.rstrip("/")

        if "/video/" in collection_url and "urn=" in collection_url:
            return [BaseElement(url=collection_url)]

        if "id=" in collection_url:
            if "/programma/" in collection_url or "/detail/" in collection_url:
                return rsi_ch.get_handler_series(collection_url)

        if "/ricerca?" in collection_url:
            return rsi_ch.get_handler_search(collection_url)
        return None
