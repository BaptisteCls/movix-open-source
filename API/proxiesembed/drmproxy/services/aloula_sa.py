import builtins
import json
import re
from os.path import join

import requests

from utils.constants.macros import ERR_MSG, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range


class aloula_sa(BaseService):
    DEMO_URLS = [
        "https://www.aloula.sa/en/title/1090",
        "https://www.aloula.sa/title/1129",
        "https://www.aloula.sa/episode/24387",
        "https://www.aloula.sa/episode/11164",
    ]

    PLAYER_URL = 'https://aloula.faulio.com/api/v1/video/{video_id}/player'
    PROJECT_URL = "https://aloula.faulio.com/api/v1.1/project/{title_id}"
    PAGE_URL = 'https://aloula.faulio.com/api/v1/video?page={page}&season={season}'
    EPISODE_URL = "https://www.aloula.sa/episode/{episode}"

    ORIGIN = "https://www.aloula.sa"

    @staticmethod
    def test_service():
        main_service.run_service(aloula_sa)

    @staticmethod
    def get_additional_params(additional):
        return [
            ("HEADER", lambda s: s.format(key="Origin", value=aloula_sa.ORIGIN))
        ] + BaseService.get_additional_params(additional)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        return aloula_sa

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            additional["license_url"], data=challenge,
            headers={"Origin": aloula_sa.ORIGIN}
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        video_id = re.search(r"/episode/([^/]+)", source_element.url).group(1)
        if source_element.element is None:
            source_element.element = f"EpisodeId_{video_id}"
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                aloula_sa.__name__
            )

        response = json.loads(requests.get(
            aloula_sa.PLAYER_URL.format(video_id=video_id),
            headers={'Origin': aloula_sa.ORIGIN}
        ).content.decode())["settings"]
        if response is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available anymore",
                solution="Do not attempt to download it"
            ))

        manifest = response["protocols"]["dash"]
        try:
            license_url = response["drm"]["license"]

            pssh_value = str(min(re.findall(
                r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                requests.get(manifest, headers={"Origin": aloula_sa.ORIGIN}).content.decode()
            ), key=len))
        except:
            return manifest, None, {}
        return manifest, pssh_value, {"license_url": license_url}

    @staticmethod
    def get_collection_elements(collection_url):
        if "/episode/" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/title/" in collection_url:
            title_id = re.search(r"/title/([^/]+)", collection_url).group(1)
            collection = []
            response = json.loads(requests.get(
                aloula_sa.PROJECT_URL.format(title_id=title_id),
                collection_url
            ).content.decode())

            if "not_found" in response.get("message", "") or "not_found" in response.get("cms_error", ""):
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=collection_url,
                    reason="The content isn't available anymore",
                    solution="Do not attempt to download it"
                ))

            visited = []
            for block in response["blocks"]:
                if block.get("seasons", None) is None:
                    continue

                block["seasons"] = sorted(block["seasons"], key=lambda s: s['order'])
                for season in block["seasons"]:
                    check = check_range(True, season["order"], None)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    last_page = json.loads(requests.get(
                        aloula_sa.PAGE_URL.format(page=0, season=season["id"]),
                    ).content.decode())["blocks"][0]["paging"]["last_page"]
                    page = last_page + 1

                    while True:
                        page -= 1
                        episodes = json.loads(requests.get(
                            aloula_sa.PAGE_URL.format(page=page, season=season["id"]),
                        ).content.decode())["blocks"][0]

                        episodes["projects"] = sorted(episodes["projects"], key=lambda e: e["episode"])
                        for episode in episodes["projects"]:
                            check = check_range(False, season["order"], episode['episode'])
                            if check is True:
                                continue
                            elif check is False:
                                return collection

                            if episode["id"] in visited:
                                continue
                            visited.append(episode["id"])
                            collection.append(BaseElement(
                                url=aloula_sa.EPISODE_URL.format(episode=episode["id"]),
                                collection=join(
                                    join(
                                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                        aloula_sa.__name__
                                    ),
                                    join(f"Title_{title_id}", f"Season_{season['order']}")
                                ),
                                element=f"Episode_{episode['episode']}"
                            ))
                        if page <= 0:
                            break
            return collection
        return None
