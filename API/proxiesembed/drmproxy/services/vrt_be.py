import builtins
import json
import re
from os.path import join
from urllib.parse import urlparse, parse_qs, quote

import browser_cookie3
import requests
import xmltodict

import utils.tools.cdm as cdm_tools
from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, clean_url


class vrt_be(BaseService):
    DEMO_URLS = [
        "https://www.vrt.be/vrtmax/a-z/knokke-off/#afleveringen",
        "https://www.vrt.be/vrtmax/a-z/doc-martin/#afleveringen",
        "https://www.vrt.be/vrtmax/a-z/dag---nacht/#trailer",
        "https://www.vrt.be/vrtmax/a-z/thuis/#alle-seizoenen",
        "https://www.vrt.be/vrtmax/a-z/thuis/#throwbackthuis",
        "https://www.vrt.be/vrtmax/a-z/fc-de-kampioenen/?seizoen=extras#afleveringen",
        "https://www.vrt.be/vrtmax/a-z/postbus-x/",
        "https://www.vrt.be/vrtmax/podcasts/studio-brussel/d/de-popcast-van-de-week/#afleveringen",
        "https://www.vrt.be/vrtmax/luister/radio/m/mnm50~55-17/#uitzendingen",
        "https://www.vrt.be/vrtmax/luister/radio/i/iedereen-klassiek~31-16/iedereen-klassiek~31-23781-0/",
        "https://www.vrt.be/vrtmax/livestream/audio/klara/",
        "https://www.vrt.be/vrtmax/livestream/video/ketnet/"
        "https://www.vrt.be/vrtmax/livestream/video/vrt-canvas/",
        "https://www.vrt.be/vrtmax/podcasts/mnm/0/22-minuten-stomme-vragen-/3/gustaph/",
        "https://www.vrt.be/vrtmax/a-z/de-gruffalo/2009/de-gruffalo/",
    ]

    TOKENS_URL = 'https://media-services-public.vrt.be/vualto-video-aggregator-web/rest/external/v2/tokens'
    ITEMS_URL = 'https://media-services-public.vrt.be/media-aggregator/v2/media-items/{id}'
    GRAPHQL_URL = 'https://www.vrt.be/vrtnu-api/graphql/public/v1'
    REFRESH_URL = 'https://www.vrt.be/vrtmax/sso/refresh'
    BASE_URL = 'https://www.vrt.be'
    LICENSE_URL = 'https://widevine-proxy.drm.technology/proxy'

    PLAYER_TOKEN = None
    PAGE_SIZE = 90

    @staticmethod
    def test_service():
        main_service.run_service(vrt_be)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/livestream/audio/" in content or "/livestream/video/" in content

    @staticmethod
    def credentials_needed():
        return {
            "OPTIONAL": True,
            "FIREFOX_COOKIES": True
        }

    @staticmethod
    def get_player_token():
        vrt_be_cookies = {}
        try:
            for c in browser_cookie3.firefox(domain_name='vrt.be'):
                vrt_be_cookies[c.name] = c.value
        except browser_cookie3.BrowserCookieError:
            pass

        response = json.loads(requests.get(
            vrt_be.REFRESH_URL, cookies=vrt_be_cookies
        ).content.decode())
        vrt_be_cookies["vrtnu-site_profile_vt"] = response.get("tokens", {}).get("video_token", "")

        player_token = json.loads(requests.post(
            vrt_be.TOKENS_URL,
            json={'identityToken': vrt_be_cookies.get("vrtnu-site_profile_vt", "")}
        ).content.decode())["vrtPlayerToken"]
        return player_token

    @staticmethod
    def initialize_service():
        if vrt_be.PLAYER_TOKEN is None:
            vrt_be.PLAYER_TOKEN = vrt_be.get_player_token()
            if vrt_be.PLAYER_TOKEN is None:
                return None
        return vrt_be

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            vrt_be.LICENSE_URL,
            data=json.dumps({
                "token": additional["token"],
                "drm_info": list(challenge)
            })
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_init_from_mpd(mpd_url):
        mpd_content = requests.get(mpd_url).content.decode()
        mpd_content = xmltodict.parse(mpd_content)["MPD"]["Period"]
        base_url = mpd_content["BaseURL"]
        if type(mpd_content["AdaptationSet"]) is not list:
            mpd_content["AdaptationSet"] = [mpd_content["AdaptationSet"]]

        best_content = None
        best_height = None
        best_bandwidth = None
        for content in mpd_content["AdaptationSet"]:
            if content["@contentType"] != "video":
                continue
            update_content = False

            height = content.get("@maxHeight", content.get("@height", None))
            if height is None:
                continue
            height = int(height)
            bandwidth = content.get("@maxBandwidth", content.get("@bandwidth", None))

            if best_content is None:
                update_content = True
            else:
                if height > best_height:
                    update_content = True
                elif height == best_height:
                    if bandwidth is not None:
                        if best_bandwidth is None:
                            update_content = True
                        elif int(bandwidth) > int(best_bandwidth):
                            update_content = True

            if update_content:
                best_content = content
                best_height = height
                best_bandwidth = bandwidth

        mpd_content = best_content
        init_url = mpd_content["SegmentTemplate"]["@initialization"]
        if type(mpd_content["Representation"]) is not list:
            mpd_content["Representation"] = [mpd_content["Representation"]]

        best_content = None
        for content in mpd_content["Representation"]:
            if best_content is None:
                best_content = content
                continue
            if int(content["@height"]) > int(best_content["@height"]):
                best_content = content
                continue
            elif int(content["@height"]) == int(best_content["@height"]):
                if int(content["@bandwidth"]) > int(best_content["@bandwidth"]):
                    best_content = content
                    continue

        init_url = init_url.replace("$RepresentationID$", best_content["@id"])
        init_url = '/'.join(mpd_url.split('/')[:-1]) + "/" + base_url + init_url
        return init_url

    @staticmethod
    def get_pssh_from_manifest(manifest):
        return cdm_tools.get_pssh_from_init(vrt_be.get_init_from_mpd(manifest))

    @staticmethod
    def get_stream_data(url):
        response = {}
        action_type = None

        if "/a-z/" in url:
            response = json.loads(requests.post(
                vrt_be.GRAPHQL_URL,
                headers={'x-vrt-client-name': 'WEB'},
                json={
                    'query': 'query VideoPage($pageId: ID!) {\n  page(id: $pageId) {\n    ... on EpisodePage {\n      objectId\n      title\n      brand\n      permalink\n      seo {\n        ...seoFragment\n        __typename\n      }\n      socialSharing {\n        ...socialSharingFragment\n        __typename\n      }\n      trackingData {\n        ...trackingDataFragment\n        __typename\n      }\n      ldjson\n      player {\n        ...playerFragment\n        __typename\n      }\n      episode {\n        objectId\n        title\n        available\n        brandLogos {\n          ...brandLogosFragment\n          __typename\n        }\n        logo\n        primaryMeta {\n          ...metaFragment\n          __typename\n        }\n        secondaryMeta {\n          ...metaFragment\n          __typename\n        }\n        image {\n          ...imageFragment\n          __typename\n        }\n        playlist {\n          __typename\n          objectId\n          activeListId\n          lists {\n            ... on StaticTileList {\n              ...basicStaticTileListFragment\n              __typename\n            }\n            __typename\n          }\n        }\n        durationSeconds\n        announcementValue\n        name\n        subtitle\n        richDescription {\n          __typename\n          html\n        }\n        program {\n          objectId\n          link\n          title\n          __typename\n        }\n        watchAction {\n          streamId\n          videoId\n          avodUrl\n          resumePoint\n          completed\n          __typename\n        }\n        shareAction {\n          title\n          description\n          image {\n            templateUrl\n            __typename\n          }\n          url\n          __typename\n        }\n        favoriteAction {\n          id\n          title\n          favorite\n          programWhatsonId\n          programUrl\n          __typename\n        }\n        __typename\n      }\n      menu {\n        ...menuFragment\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment metaFragment on MetaDataItem {\n  __typename\n  type\n  value\n  shortValue\n  longValue\n}\nfragment imageFragment on Image {\n  __typename\n  objectId\n  alt\n  title\n  focalPoint\n  templateUrl\n}\nfragment seoFragment on SeoProperties {\n  __typename\n  title\n  description\n}\nfragment socialSharingFragment on SocialSharingProperties {\n  __typename\n  title\n  description\n  image {\n    __typename\n    objectId\n    templateUrl\n  }\n}\nfragment brandLogosFragment on Logo {\n  colorOnColor\n  height\n  mono\n  primary\n  type\n  width\n}\nfragment trackingDataFragment on PageTrackingData {\n  data\n  perTrigger {\n    trigger\n    data\n    template {\n      id\n      __typename\n    }\n    __typename\n  }\n}\nfragment playerFragment on MediaPlayer {\n  __typename\n  objectId\n  expires\n  image {\n    ...imageFragment\n    __typename\n  }\n  listenAction {\n    __typename\n    ... on LiveListenAction {\n      streamId\n      pageLink: livestreamPageLink\n      startDate\n      __typename\n    }\n    ... on PodcastEpisodeListenAction {\n      streamId\n      pageLink: podcastEpisodeLink\n      resumePointId: audioId\n      resumePoint\n      completed\n      __typename\n    }\n    ... on RadioEpisodeListenAction {\n      streamId\n      radioEpisodeId\n      pageLink\n      startDate\n      endDate\n      __typename\n    }\n  }\n  modes {\n    __typename\n    active\n    token {\n      placeholder\n      value\n      __typename\n    }\n  }\n  secondaryMeta {\n    ...metaFragment\n    __typename\n  }\n  sportBuffStreamId\n  subtitle\n  title\n  watchAction {\n    __typename\n    ... on LiveWatchAction {\n      streamId\n      pageLink: livestreamPageLink\n      startDate\n      __typename\n    }\n    ... on EpisodeWatchAction {\n      streamId\n      pageLink: videoUrl\n      resumePointId: videoId\n      resumePoint\n      completed\n      avodUrl\n      __typename\n    }\n  }\n}\nfragment menuFragment on ContainerNavigation {\n  __typename\n  objectId\n  items {\n    __typename\n    objectId\n    componentId\n    title\n    active\n  }\n}\nfragment basicStaticTileListFragment on StaticTileList {\n  __typename\n  objectId\n  listId\n  displayType\n  expires\n  tileVariant\n  tileContentType\n  tileOrientation\n  title\n  items {\n    ...tileFragment\n    __typename\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n}\nfragment tileFragment on Tile {\n  ... on IIdentifiable {\n    __typename\n    objectId\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n  ... on ITile {\n    description\n    title\n    active\n    action {\n      ...actionFragment\n      __typename\n    }\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    image {\n      ...imageFragment\n      __typename\n    }\n    primaryMeta {\n      ...metaFragment\n      __typename\n    }\n    secondaryMeta {\n      ...metaFragment\n      __typename\n    }\n    tertiaryMeta {\n      ...metaFragment\n      __typename\n    }\n    indexMeta {\n      __typename\n      type\n      value\n    }\n    statusMeta {\n      __typename\n      type\n      value\n    }\n    labelMeta {\n      __typename\n      type\n      value\n    }\n    __typename\n  }\n  ... on ContentTile {\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    __typename\n  }\n  ... on BannerTile {\n    compactLayout\n    backgroundColor\n    textTheme\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    ctaText\n    passUserIdentity\n    titleArt {\n      objectId\n      templateUrl\n      __typename\n    }\n    __typename\n  }\n  ... on EpisodeTile {\n    description\n    formattedDuration\n    available\n    chapterStart\n    action {\n      ...actionFragment\n      __typename\n    }\n    playAction: watchAction {\n      pageUrl: videoUrl\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    episode {\n      __typename\n      objectId\n      program {\n        __typename\n        objectId\n        link\n      }\n    }\n    \n    __typename\n  }\n  ... on PodcastEpisodeTile {\n    formattedDuration\n    available\n    programLink: podcastEpisode {\n      objectId\n      podcastProgram {\n        objectId\n        link\n        __typename\n      }\n      __typename\n    }\n    playAction: listenAction {\n      pageUrl: podcastEpisodeLink\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    __typename\n  }\n  ... on PodcastProgramTile {\n    link\n    __typename\n  }\n  ... on ProgramTile {\n    link\n    __typename\n  }\n  ... on AudioLivestreamTile {\n    brand\n    brandsLogos {\n      brand\n      brandTitle\n      logos {\n        ...brandLogosFragment\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  ... on LivestreamTile {\n    description\n    __typename\n  }\n  ... on ButtonTile {\n    icon\n    iconPosition\n    mode\n    __typename\n  }\n  ... on RadioEpisodeTile {\n    action {\n      ...actionFragment\n      __typename\n    }\n    available\n    \n    formattedDuration\n   ...componentTrackingDataFragment\n    __typename\n  }\n  ... on SongTile {\n    startDate\n    formattedStartDate\n    endDate\n    __typename\n  }\n  ... on RadioProgramTile {\n    objectId\n    __typename\n  }\n}\nfragment actionFragment on Action {\n  __typename\n  ... on FavoriteAction {\n    favorite\n    id\n    programUrl\n    programWhatsonId\n    title\n    __typename\n  }\n  ... on ListDeleteAction {\n    listName\n    id\n    listId\n    title\n    __typename\n  }\n  ... on ListTileDeletedAction {\n    listName\n    id\n    listId\n    __typename\n  }\n  ... on PodcastEpisodeListenAction {\n    id: audioId\n    podcastEpisodeLink\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on EpisodeWatchAction {\n    id: videoId\n    videoUrl\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on LinkAction {\n    id: linkId\n    linkId\n    link\n    linkType\n    openExternally\n    passUserIdentity\n    linkTokens {\n      __typename\n      placeholder\n      value\n    }\n    __typename\n  }\n  ... on ShareAction {\n    title\n    url\n    __typename\n  }\n  ... on SwitchTabAction {\n    referencedTabId\n    mediaType\n    link\n    __typename\n  }\n  ... on RadioEpisodeListenAction {\n    streamId\n    pageLink\n    startDate\n    __typename\n  }\n  ... on LiveListenAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n  ... on LiveWatchAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n}\nfragment actionItemFragment on ActionItem {\n  __typename\n  objectId\n  accessibilityLabel\n  action {\n    ...actionFragment\n    __typename\n  }\n  active\n  icon\n  iconPosition\n  icons {\n    __typename\n    position\n    ... on DesignSystemIcon {\n      value {\n        name\n        __typename\n      }\n      __typename\n    }\n  }\n  mode\n  objectId\n  title\n}\nfragment componentTrackingDataFragment on IComponent {\n  trackingData {\n    data\n    perTrigger {\n      trigger\n      data\n      template {\n        id\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}',
                    'operationName': 'VideoPage',
                    'variables': {'pageId': f'/vrtnu/{url.split("/vrtmax/")[1]}.model.json'}
                }
            ).content.decode())
            action_type = "watchAction"

        if "/podcasts/" in url:
            response = json.loads(requests.post(
                vrt_be.GRAPHQL_URL,
                headers={'x-vrt-client-name': 'WEB'},
                json={
                    'query': 'query PodcastPage($pageId: ID!) {\n  page(id: $pageId) {\n    ... on PodcastEpisodePage {\n      objectId\n      permalink\n      brand\n      seo {\n        ...seoFragment\n        __typename\n      }\n      socialSharing {\n        ...socialSharingFragment\n        __typename\n      }\n      trackingData {\n        data\n        perTrigger {\n          trigger\n          data\n          template {\n            id\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      ldjson\n      components {\n        __typename\n        ... on IComponent {\n          ... on PageHeader {\n            objectId\n            categories {\n              title\n              name\n              category\n              __typename\n            }\n            brandsLogos {\n              brand\n              brandTitle\n              logos {\n                mono\n                primary\n                type\n                __typename\n              }\n              __typename\n            }\n            __typename\n          }\n          __typename\n        }\n        ... on ContainerNavigation {\n          objectId\n          __typename\n        }\n      }\n      menu {\n        ...menuFragment\n        __typename\n      }\n      player {\n        ...playerFragment\n        __typename\n      }\n      podcastEpisode {\n        objectId\n        title\n        available\n        richDescription {\n          __typename\n          html\n        }\n        image {\n          objectId\n          templateUrl\n          __typename\n        }\n        listenAction {\n          audioId\n          streamId\n          publicationDate\n          resumePoint\n          completed\n          __typename\n        }\n        presenters {\n          name\n          category\n          title\n          __typename\n        }\n        primaryMeta {\n          ...metaFragment\n          __typename\n        }\n        secondaryMeta {\n          ...metaFragment\n          __typename\n        }\n        shareAction {\n          title\n          description\n          image {\n            objectId\n            templateUrl\n            __typename\n          }\n          url\n          __typename\n        }\n        podcastProgram {\n          objectId\n          title\n          link\n          __typename\n        }\n        podcastSeason {\n          objectId\n          title\n          __typename\n        }\n        episodeNumberRaw\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment menuFragment on ContainerNavigation {\n  __typename\n  objectId\n  items {\n    __typename\n    objectId\n    componentId\n    title\n    active\n  }\n}\nfragment metaFragment on MetaDataItem {\n  __typename\n  type\n  value\n  shortValue\n  longValue\n}\nfragment seoFragment on SeoProperties {\n  __typename\n  title\n  description\n}\nfragment socialSharingFragment on SocialSharingProperties {\n  __typename\n  title\n  description\n  image {\n    __typename\n    objectId\n    templateUrl\n  }\n}\nfragment playerFragment on MediaPlayer {\n  __typename\n  objectId\n  expires\n  image {\n    ...imageFragment\n    __typename\n  }\n  listenAction {\n    __typename\n    ... on LiveListenAction {\n      streamId\n      pageLink: livestreamPageLink\n      startDate\n      __typename\n    }\n    ... on PodcastEpisodeListenAction {\n      streamId\n      pageLink: podcastEpisodeLink\n      resumePointId: audioId\n      resumePoint\n      completed\n      __typename\n    }\n    ... on RadioEpisodeListenAction {\n      streamId\n      radioEpisodeId\n      pageLink\n      startDate\n      endDate\n      __typename\n    }\n  }\n  modes {\n    __typename\n    active\n    token {\n      placeholder\n      value\n      __typename\n    }\n  }\n  secondaryMeta {\n    ...metaFragment\n    __typename\n  }\n  sportBuffStreamId\n  subtitle\n  title\n  watchAction {\n    __typename\n    ... on LiveWatchAction {\n      streamId\n      pageLink: livestreamPageLink\n      startDate\n      __typename\n    }\n    ... on EpisodeWatchAction {\n      streamId\n      pageLink: videoUrl\n      resumePointId: videoId\n      resumePoint\n      completed\n      avodUrl\n      __typename\n    }\n  }\n}\nfragment imageFragment on Image {\n  __typename\n  objectId\n  alt\n  title\n  focalPoint\n  templateUrl\n}',
                    'operationName': 'PodcastPage',
                    'variables': {'pageId': f'/vrtnu/{url.split("/vrtmax/")[1]}.model.json'}
                }
            ).content.decode())
            action_type = "listenAction"

        if "/livestream/audio/" in url or "/livestream/video/" in url:
            response = json.loads(requests.post(
                vrt_be.GRAPHQL_URL,
                headers={'x-vrt-client-name': 'WEB'},
                json={
                    'query': 'query Livestream($pageId: ID!, $miniQuery: Boolean = false) {\n  page(id: $pageId) {\n    ... on IIdentifiable {\n      __typename\n      objectId\n    }\n    ... on IPage @skip(if: $miniQuery) {\n      title\n      brand\n      permalink\n      trackingData {\n        ...trackingDataFragment\n        __typename\n      }\n      components {\n        __typename\n        ... on IComponent {\n          ...componentTrackingDataFragment\n          __typename\n        }\n        ...bannerFragment\n      }\n      seo {\n        ...seoFragment\n        __typename\n      }\n      socialSharing {\n        ...socialSharingFragment\n        __typename\n      }\n      __typename\n    }\n    ... on AudioLivestreamPage {\n      linkTemplate\n      description\n      livestream {\n        objectId\n        title\n        presenters {\n          name\n          title\n          category\n          __typename\n        }\n        ... on AudioLivestream @skip(if: $miniQuery) {\n          actionItems {\n            ...actionItemFragment\n            __typename\n          }\n          brandLogos {\n            ...brandLogosFragment\n            __typename\n          }\n          shareAction {\n            title\n            url\n            __typename\n          }\n          primaryMeta {\n            ...metaFragment\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      player {\n        ...playerFragment\n        __typename\n      }\n      menu @skip(if: $miniQuery) {\n        ...menuFragment\n        __typename\n      }\n      __typename\n    }\n    ... on LivestreamPage {\n      description\n      livestream {\n        objectId\n        brandLogos @skip(if: $miniQuery) {\n          ...brandLogosFragment\n          __typename\n        }\n        shareAction @skip(if: $miniQuery) {\n          title\n          url\n          __typename\n        }\n        title\n        primaryMeta @skip(if: $miniQuery) {\n          ...metaFragment\n          __typename\n        }\n        episode @skip(if: $miniQuery) {\n          ... on Episode {\n            objectId\n            program {\n              ... on Program {\n                objectId\n                title\n                description\n                link\n                __typename\n              }\n              __typename\n            }\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      player {\n        ...playerFragment\n        __typename\n      }\n      menu {\n        ...menuFragment\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment metaFragment on MetaDataItem {\n  __typename\n  type\n  value\n  shortValue\n  longValue\n}\nfragment bannerFragment on Banner {\n  __typename\n  objectId\n  brand\n  countdown {\n    date\n    __typename\n  }\n  richDescription {\n    __typename\n    text\n  }\n  ctaText\n  image {\n    objectId\n    templateUrl\n    alt\n    focalPoint\n    __typename\n  }\n  title\n  compactLayout\n  textTheme\n  backgroundColor\n  style\n  action {\n    ...actionFragment\n    __typename\n  }\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n  titleArt {\n    objectId\n    templateUrl\n    __typename\n  }\n  labelMeta {\n    __typename\n    type\n    value\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n}\nfragment actionFragment on Action {\n  __typename\n  ... on FavoriteAction {\n    favorite\n    id\n    programUrl\n    programWhatsonId\n    title\n    __typename\n  }\n  ... on ListDeleteAction {\n    listName\n    id\n    listId\n    title\n    __typename\n  }\n  ... on ListTileDeletedAction {\n    listName\n    id\n    listId\n    __typename\n  }\n  ... on PodcastEpisodeListenAction {\n    id: audioId\n    podcastEpisodeLink\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on EpisodeWatchAction {\n    id: videoId\n    videoUrl\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on LinkAction {\n    id: linkId\n    linkId\n    link\n    linkType\n    openExternally\n    passUserIdentity\n    linkTokens {\n      __typename\n      placeholder\n      value\n    }\n    __typename\n  }\n  ... on ShareAction {\n    title\n    url\n    __typename\n  }\n  ... on SwitchTabAction {\n    referencedTabId\n    mediaType\n    link\n    __typename\n  }\n  ... on RadioEpisodeListenAction {\n    streamId\n    pageLink\n    startDate\n    __typename\n  }\n  ... on LiveListenAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n  ... on LiveWatchAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n}\nfragment actionItemFragment on ActionItem {\n  __typename\n  objectId\n  accessibilityLabel\n  action {\n    ...actionFragment\n    __typename\n  }\n  active\n  icon\n  iconPosition\n  icons {\n    __typename\n    position\n    ... on DesignSystemIcon {\n      value {\n        name\n        __typename\n      }\n      __typename\n    }\n  }\n  mode\n  objectId\n  title\n}\nfragment componentTrackingDataFragment on IComponent {\n  trackingData {\n    data\n    perTrigger {\n      trigger\n      data\n      template {\n        id\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment brandLogosFragment on Logo {\n  colorOnColor\n  height\n  mono\n  primary\n  type\n  width\n}\nfragment playerFragment on MediaPlayer {\n  __typename\n  objectId\n  expires\n  image {\n    ...imageFragment\n    __typename\n  }\n  listenAction {\n    __typename\n    ... on LiveListenAction {\n      streamId\n      pageLink: livestreamPageLink\n      startDate\n      __typename\n    }\n    ... on PodcastEpisodeListenAction {\n      streamId\n      pageLink: podcastEpisodeLink\n      resumePointId: audioId\n      resumePoint\n      completed\n      __typename\n    }\n    ... on RadioEpisodeListenAction {\n      streamId\n      radioEpisodeId\n      pageLink\n      startDate\n      endDate\n      __typename\n    }\n  }\n  modes {\n    __typename\n    active\n    token {\n      placeholder\n      value\n      __typename\n    }\n  }\n  secondaryMeta {\n    ...metaFragment\n    __typename\n  }\n  sportBuffStreamId\n  subtitle\n  title\n  watchAction {\n    __typename\n    ... on LiveWatchAction {\n      streamId\n      pageLink: livestreamPageLink\n      startDate\n      __typename\n    }\n    ... on EpisodeWatchAction {\n      streamId\n      pageLink: videoUrl\n      resumePointId: videoId\n      resumePoint\n      completed\n      avodUrl\n      __typename\n    }\n  }\n}\nfragment imageFragment on Image {\n  __typename\n  objectId\n  alt\n  title\n  focalPoint\n  templateUrl\n}\nfragment seoFragment on SeoProperties {\n  __typename\n  title\n  description\n}\nfragment socialSharingFragment on SocialSharingProperties {\n  __typename\n  title\n  description\n  image {\n    __typename\n    objectId\n    templateUrl\n  }\n}\nfragment trackingDataFragment on PageTrackingData {\n  data\n  perTrigger {\n    trigger\n    data\n    template {\n      id\n      __typename\n    }\n    __typename\n  }\n}\nfragment menuFragment on ContainerNavigation {\n  __typename\n  objectId\n  items {\n    __typename\n    objectId\n    componentId\n    title\n    active\n  }\n}',
                    'operationName': 'Livestream',
                    'variables': {'pageId': f'/vrtmax/{url.split("/vrtmax/")[1]}/'}
                }
            ).content.decode())
            if "/livestream/audio/" in url:
                action_type = "listenAction"
            else:
                action_type = "watchAction"

        if "/luister/radio/" in url:
            response = json.loads(requests.post(
                vrt_be.GRAPHQL_URL,
                headers={'x-vrt-client-name': 'WEB'},
                json={
                    'query': 'query RadioEpisodePage($pageId: ID!) {\n  page(id: $pageId) {\n    ... on RadioEpisodePage {\n      objectId\n      title\n      brand\n      permalink\n      seo {\n        ...seoFragment\n        __typename\n      }\n      socialSharing {\n        ...socialSharingFragment\n        __typename\n      }\n      trackingData {\n        ...trackingDataFragment\n        __typename\n      }\n      header {\n        title\n        announcementValue\n        brandsLogos {\n          brandTitle\n          logos {\n            type\n            mono\n            width\n            height\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      menu {\n        ...menuFragment\n        __typename\n      }\n      player {\n        ...playerFragment\n        __typename\n      }\n      radioEpisode {\n        objectId\n        title\n        richDescription {\n          __typename\n          html\n          text\n        }\n        brand\n        startDate\n        brandLogos {\n          ...brandLogosFragment\n          __typename\n        }\n        image {\n          ...imageFragment\n          __typename\n        }\n        brand\n        presenters {\n          name\n          category\n          title\n          icon\n          __typename\n        }\n        primaryMeta {\n          ...metaFragment\n          __typename\n        }\n        secondaryMeta {\n          ...metaFragment\n          __typename\n        }\n        actionItems {\n          ...actionItemFragment\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment actionItemFragment on ActionItem {\n  __typename\n  objectId\n  accessibilityLabel\n  action {\n    ...actionFragment\n    __typename\n  }\n  active\n  icon\n  iconPosition\n  icons {\n    __typename\n    position\n    ... on DesignSystemIcon {\n      value {\n        name\n        __typename\n      }\n      __typename\n    }\n  }\n  mode\n  objectId\n  title\n}\nfragment actionFragment on Action {\n  __typename\n  ... on FavoriteAction {\n    favorite\n    id\n    programUrl\n    programWhatsonId\n    title\n    __typename\n  }\n  ... on ListDeleteAction {\n    listName\n    id\n    listId\n    title\n    __typename\n  }\n  ... on ListTileDeletedAction {\n    listName\n    id\n    listId\n    __typename\n  }\n  ... on PodcastEpisodeListenAction {\n    id: audioId\n    podcastEpisodeLink\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on EpisodeWatchAction {\n    id: videoId\n    videoUrl\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on LinkAction {\n    id: linkId\n    linkId\n    link\n    linkType\n    openExternally\n    passUserIdentity\n    linkTokens {\n      __typename\n      placeholder\n      value\n    }\n    __typename\n  }\n  ... on ShareAction {\n    title\n    url\n    __typename\n  }\n  ... on SwitchTabAction {\n    referencedTabId\n    mediaType\n    link\n    __typename\n  }\n  ... on RadioEpisodeListenAction {\n    streamId\n    pageLink\n    startDate\n    __typename\n  }\n  ... on LiveListenAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n  ... on LiveWatchAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n}\nfragment imageFragment on Image {\n  __typename\n  objectId\n  alt\n  title\n  focalPoint\n  templateUrl\n}\nfragment seoFragment on SeoProperties {\n  __typename\n  title\n  description\n}\nfragment socialSharingFragment on SocialSharingProperties {\n  __typename\n  title\n  description\n  image {\n    __typename\n    objectId\n    templateUrl\n  }\n}\nfragment metaFragment on MetaDataItem {\n  __typename\n  type\n  value\n  shortValue\n  longValue\n}\nfragment trackingDataFragment on PageTrackingData {\n  data\n  perTrigger {\n    trigger\n    data\n    template {\n      id\n      __typename\n    }\n    __typename\n  }\n}\nfragment brandLogosFragment on Logo {\n  colorOnColor\n  height\n  mono\n  primary\n  type\n  width\n}\nfragment playerFragment on MediaPlayer {\n  __typename\n  objectId\n  expires\n  image {\n    ...imageFragment\n    __typename\n  }\n  listenAction {\n    __typename\n    ... on LiveListenAction {\n      streamId\n      pageLink: livestreamPageLink\n      startDate\n      __typename\n    }\n    ... on PodcastEpisodeListenAction {\n      streamId\n      pageLink: podcastEpisodeLink\n      resumePointId: audioId\n      resumePoint\n      completed\n      __typename\n    }\n    ... on RadioEpisodeListenAction {\n      streamId\n      radioEpisodeId\n      pageLink\n      startDate\n      endDate\n      __typename\n    }\n  }\n  modes {\n    __typename\n    active\n    token {\n      placeholder\n      value\n      __typename\n    }\n  }\n  secondaryMeta {\n    ...metaFragment\n    __typename\n  }\n  sportBuffStreamId\n  subtitle\n  title\n  watchAction {\n    __typename\n    ... on LiveWatchAction {\n      streamId\n      pageLink: livestreamPageLink\n      startDate\n      __typename\n    }\n    ... on EpisodeWatchAction {\n      streamId\n      pageLink: videoUrl\n      resumePointId: videoId\n      resumePoint\n      completed\n      avodUrl\n      __typename\n    }\n  }\n}\nfragment menuFragment on ContainerNavigation {\n  __typename\n  objectId\n  items {\n    __typename\n    objectId\n    componentId\n    title\n    active\n  }\n}',
                    'operationName': 'RadioEpisodePage',
                    'variables': {'pageId': f'/vrtnu/{url.split("/vrtmax/")[1]}/'}
                }
            ).content.decode())
            action_type = "listenAction"

        if action_type is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=url,
                reason="URL not supported",
                solution=f"Extend the {vrt_be.__name__} service"
            ))

        response = response["data"]["page"]
        if response is None or response["player"][action_type] is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        response = response["player"]
        return response[action_type]["streamId"], response["title"]

    @staticmethod
    def get_video_data(source_element):
        source_element.url = source_element.url.rstrip('/')
        stream_id, stream_title = vrt_be.get_stream_data(source_element.url)

        response = requests.get(
            vrt_be.ITEMS_URL.format(id=stream_id),
            params={
                'vrtPlayerToken': vrt_be.PLAYER_TOKEN,
                'client': 'vrtnu-web@PROD'
            }
        )

        if response.status_code == 404:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        response = json.loads(response.content.decode())
        message = response.get("code", "").lower()
        if "available_only" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need Belgian IP to access content",
                solution="Use a VPN"
            ))
        if "authentication" in message or "restricted" in message:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason='Need account for this content and/or fresh cookies',
                solution=f'Sign into your account using Firefox and play a random video. '
                         f'If it persists then debug the {vrt_be.__name__} service'
            ))

        if len(message) > 0:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Unknown error encountered: {str(response)}",
                solution=f"Debug the {vrt_be.__name__} service"
            ))

        if source_element.element is None:
            if response["title"] is None or len(response["title"].strip()) == 0:
                response["title"] = stream_title
            source_element.element = get_valid_filename(response["title"])
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                vrt_be.__name__
            )

        manifest = None
        for target in response['targetUrls']:
            if "dash" in target["type"].lower():
                manifest = target["url"]
                break

        pssh_value = None
        if response["drm"] is not None:
            pssh_value = vrt_be.get_pssh_from_manifest(manifest)
        return manifest, pssh_value, {"token": response["drm"]}

    @staticmethod
    def get_label_index(label):
        if label is None or len(label) == 0:
            return None
        label = label.lower()
        label = re.sub(r'\s+', ' ', label)
        label = label.replace(' ', "_")
        for s in [
            "seizoen_", "aflevering_", "afl\\.", "-s\\d+a", "-s\\d+-a", "-\\d+a", "-\\d+-a",
            "-s\\d+a-", "-s\\d+-a-", "-\\d+a-", "-\\d+-a-", "sspecialsa"
        ]:
            try:
                return int(re.findall(fr'{s}(\d+)', label)[0])
            except:
                pass
        return None

    @staticmethod
    def get_episode_index(metadata, url):
        for meta in metadata:
            value = meta["value"].lower()
            if "aflevering" in value or "afl" in value:
                return vrt_be.get_label_index(meta["value"])

        index = vrt_be.get_label_index(url)
        if index is None:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=url,
                reason="Failed to extract the episode index",
                solution=f"Debug the {vrt_be.__name__} service"
            ))
        return index

    @staticmethod
    def check_order(type_elements, elements):
        if len(elements) < 2:
            return True

        e1, e2 = elements[0:2]
        if type_elements == "paginatedItems":
            e1, e2 = e1["node"], e2["node"]

        e1_url = f'{vrt_be.BASE_URL}{e1["playAction"]["pageUrl"]}'
        e1_index = vrt_be.get_episode_index(e1["primaryMeta"], e1_url)
        e2_url = f'{vrt_be.BASE_URL}{e2["playAction"]["pageUrl"]}'
        e2_index = vrt_be.get_episode_index(e2["primaryMeta"], e2_url)
        return e1_index < e2_index

    @staticmethod
    def clean_title(title):
        title = title.lower().replace(' ', '-')
        title = quote(title)
        title = re.sub(r'%[0-9a-fA-F]{2}', '', title)
        return title

    @staticmethod
    def radio_handler(collection_name, component_id):
        response = json.loads(requests.post(
            vrt_be.GRAPHQL_URL,
            headers={'x-vrt-client-name': 'WEB'},
            json={
                'query': 'query component($componentId: ID!, $lazyItemCount: Int = ' +
                         str(vrt_be.PAGE_SIZE) +
                         ', $after: ID, $before: ID) {\n  component(id: $componentId) {\n    __typename\n    ... on ContainerNavigationItem {\n      __typename\n      objectId\n      componentId\n      title\n      components {\n        __typename\n        ... on PaginatedTileList {\n          ...basicPaginatedTileListFragment\n          __typename\n        }\n        ... on StaticTileList {\n          ...basicStaticTileListFragment\n          __typename\n        }\n        ... on ElectronicProgramGuideSchedule {\n          ...epgFragment\n          __typename\n        }\n        ... on Chat {\n          __typename\n          chatId\n          expires\n          objectId\n          ...componentTrackingDataFragment\n        }\n        ... on Text {\n          ...textFragment\n          __typename\n        }\n        ... on PresentersList {\n          __typename\n          objectId\n          presenters {\n            title\n            __typename\n          }\n        }\n        ... on NoContent {\n          ...noContentFragment\n          __typename\n        }\n      }\n    }\n  }\n}\nfragment actionFragment on Action {\n  __typename\n  ... on FavoriteAction {\n    favorite\n    id\n    programUrl\n    programWhatsonId\n    title\n    __typename\n  }\n  ... on ListDeleteAction {\n    listName\n    id\n    listId\n    title\n    __typename\n  }\n  ... on ListTileDeletedAction {\n    listName\n    id\n    listId\n    __typename\n  }\n  ... on PodcastEpisodeListenAction {\n    id: audioId\n    podcastEpisodeLink\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on EpisodeWatchAction {\n    id: videoId\n    videoUrl\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on LinkAction {\n    id: linkId\n    linkId\n    link\n    linkType\n    openExternally\n    passUserIdentity\n    linkTokens {\n      __typename\n      placeholder\n      value\n    }\n    __typename\n  }\n  ... on ShareAction {\n    title\n    url\n    __typename\n  }\n  ... on SwitchTabAction {\n    referencedTabId\n    mediaType\n    link\n    __typename\n  }\n  ... on RadioEpisodeListenAction {\n    streamId\n    pageLink\n    startDate\n    __typename\n  }\n  ... on LiveListenAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n  ... on LiveWatchAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n}\nfragment actionItemFragment on ActionItem {\n  __typename\n  objectId\n  accessibilityLabel\n  action {\n    ...actionFragment\n    __typename\n  }\n  active\n  icon\n  iconPosition\n  icons {\n    __typename\n    position\n    ... on DesignSystemIcon {\n      value {\n        name\n        __typename\n      }\n      __typename\n    }\n  }\n  mode\n  objectId\n  title\n}\nfragment componentTrackingDataFragment on IComponent {\n  trackingData {\n    data\n    perTrigger {\n      trigger\n      data\n      template {\n        id\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment noContentFragment on NoContent {\n  __typename\n  objectId\n  title\n  text\n  noContentType\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n}\nfragment tileFragment on Tile {\n  ... on IIdentifiable {\n    __typename\n    objectId\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n  ... on ITile {\n    description\n    title\n    active\n    action {\n      ...actionFragment\n      __typename\n    }\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    image {\n      ...imageFragment\n      __typename\n    }\n    primaryMeta {\n      ...metaFragment\n      __typename\n    }\n    secondaryMeta {\n      ...metaFragment\n      __typename\n    }\n    tertiaryMeta {\n      ...metaFragment\n      __typename\n    }\n    indexMeta {\n      __typename\n      type\n      value\n    }\n    statusMeta {\n      __typename\n      type\n      value\n    }\n    labelMeta {\n      __typename\n      type\n      value\n    }\n    __typename\n  }\n  ... on ContentTile {\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    __typename\n  }\n  ... on BannerTile {\n    compactLayout\n    backgroundColor\n    textTheme\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    ctaText\n    passUserIdentity\n    titleArt {\n      objectId\n      templateUrl\n      __typename\n    }\n    __typename\n  }\n  ... on EpisodeTile {\n    description\n    formattedDuration\n    available\n    chapterStart\n    action {\n      ...actionFragment\n      __typename\n    }\n    playAction: watchAction {\n      pageUrl: videoUrl\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    episode {\n      __typename\n      objectId\n      program {\n        __typename\n        objectId\n        link\n      }\n    }\n    \n    __typename\n  }\n  ... on PodcastEpisodeTile {\n    formattedDuration\n    available\n    programLink: podcastEpisode {\n      objectId\n      podcastProgram {\n        objectId\n        link\n        __typename\n      }\n      __typename\n    }\n    playAction: listenAction {\n      pageUrl: podcastEpisodeLink\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    __typename\n  }\n  ... on PodcastProgramTile {\n    link\n    __typename\n  }\n  ... on ProgramTile {\n    link\n    __typename\n  }\n  ... on AudioLivestreamTile {\n    brand\n    brandsLogos {\n      brand\n      brandTitle\n      logos {\n        ...brandLogosFragment\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  ... on LivestreamTile {\n    description\n    __typename\n  }\n  ... on ButtonTile {\n    icon\n    iconPosition\n    mode\n    __typename\n  }\n  ... on RadioEpisodeTile {\n    action {\n      ...actionFragment\n      __typename\n    }\n    available\n    \n    formattedDuration\n  ...componentTrackingDataFragment\n    __typename\n  }\n  ... on SongTile {\n    startDate\n    formattedStartDate\n    endDate\n    __typename\n  }\n  ... on RadioProgramTile {\n    objectId\n    __typename\n  }\n}\nfragment metaFragment on MetaDataItem {\n  __typename\n  type\n  value\n  shortValue\n  longValue\n}\nfragment imageFragment on Image {\n  __typename\n  objectId\n  alt\n  title\n  focalPoint\n  templateUrl\n}\nfragment brandLogosFragment on Logo {\n  colorOnColor\n  height\n  mono\n  primary\n  type\n  width\n}\nfragment textFragment on Text {\n  __typename\n  objectId\n  html\n}\nfragment basicPaginatedTileListFragment on PaginatedTileList {\n  __typename\n  objectId\n  listId\n  displayType\n  expires\n  tileVariant\n  tileContentType\n  tileOrientation\n  title\n  paginatedItems(first: $lazyItemCount, after: $after, before: $before) {\n    __typename\n    edges {\n      __typename\n      cursor\n      node {\n        __typename\n        ...tileFragment\n      }\n    }\n    pageInfo {\n      __typename\n      endCursor\n      hasNextPage\n      hasPreviousPage\n      startCursor\n    }\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n}\nfragment basicStaticTileListFragment on StaticTileList {\n  __typename\n  objectId\n  listId\n  displayType\n  expires\n  tileVariant\n  tileContentType\n  tileOrientation\n  title\n  items {\n    ...tileFragment\n    __typename\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n}\nfragment epgFragment on ElectronicProgramGuideSchedule {\n  __typename\n  objectId\n  expires\n  current {\n    tile {\n      ...tileFragment\n      __typename\n    }\n    __typename\n  }\n  next {\n    ...basicPaginatedTileListFragment\n    __typename\n  }\n  previous {\n    ...basicPaginatedTileListFragment\n    __typename\n  }\n}',
                'operationName': 'component',
                'variables': {'componentId': component_id}
            }
        ).content.decode())

        response = response["data"]["component"]
        episode_index = 0
        collection = []

        for component in response.get("components", []):
            if component["__typename"] == "StaticTileList":
                for item in component["items"]:
                    episode_index += 1

                    check = check_range(False, None, episode_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    collection.append(BaseElement(
                        url=f'{vrt_be.BASE_URL}{item["action"]["pageLink"]}',
                        collection=join(join(
                            str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                            vrt_be.__name__
                        ), collection_name),
                        element=f'Radio_{episode_index}'
                                f'_'
                                f'{get_valid_filename(item["title"])}'
                    ))

                return collection
        return None

    @staticmethod
    def container_navigation_handler(collection_name, container, selected_season_name, fragment, url):
        collection = []
        if fragment is not None:
            collection_name = join(collection_name, get_valid_filename(fragment))
        if selected_season_name is not None:
            collection_name = join(collection_name, get_valid_filename(selected_season_name))

        for i1 in container["items"]:
            collection_index = vrt_be.get_label_index(i1["title"])
            if collection_index is None and vrt_be.clean_title(i1["title"]) != fragment:
                continue

            if "/luister/radio/" in url and i1.get("components", None) is None:
                return vrt_be.radio_handler(collection_name, i1["componentId"])

            season_index = 0
            for c1 in i1["components"]:
                seasons = []
                ignore_index = False
                if "/podcasts/" in url in url:
                    ignore_index = True

                if len(c1.get("paginatedItems", [])) > 0:
                    if collection_index is None:
                        collection_index = vrt_be.get_label_index(c1["title"])
                    if collection_index is not None:
                        season_index = collection_index
                    else:
                        season_index += 1
                        ignore_index = True

                    response = json.loads(requests.post(
                        vrt_be.GRAPHQL_URL,
                        headers={'x-vrt-client-name': 'WEB'},
                        json={
                            'query': 'query PaginatedTileListPage($listId: ID!, $lazyItemCount: Int = ' +
                                     str(vrt_be.PAGE_SIZE) +
                                     ', $after: ID, $before: ID) {\n  list(listId: $listId) {\n    __typename\n    ... on PaginatedTileList {\n      ...paginatedTileListFragment\n      __typename\n    }\n    ... on StaticTileList {\n      ...staticTileListFragment\n      __typename\n    }\n  }\n}\nfragment staticTileListFragment on StaticTileList {\n  __typename\n  objectId\n  listId\n  title\n  description\n  tileContentType\n  tileOrientation\n  displayType\n  expires\n  tileVariant\n  sort {\n    icon\n    order\n    title\n    __typename\n  }\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n  banner {\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    description\n    image {\n      ...imageFragment\n      __typename\n    }\n    compactLayout\n    backgroundColor\n    textTheme\n    title\n    titleArt {\n      objectId\n      templateUrl\n      __typename\n    }\n    __typename\n  }\n  bannerSize\n  items {\n    ...tileFragment\n    __typename\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n}\nfragment actionItemFragment on ActionItem {\n  __typename\n  objectId\n  accessibilityLabel\n  action {\n    ...actionFragment\n    __typename\n  }\n  active\n  icon\n  iconPosition\n  icons {\n    __typename\n    position\n    ... on DesignSystemIcon {\n      value {\n        name\n        __typename\n      }\n      __typename\n    }\n  }\n  mode\n  objectId\n  title\n}\nfragment actionFragment on Action {\n  __typename\n  ... on FavoriteAction {\n    favorite\n    id\n    programUrl\n    programWhatsonId\n    title\n    __typename\n  }\n  ... on ListDeleteAction {\n    listName\n    id\n    listId\n    title\n    __typename\n  }\n  ... on ListTileDeletedAction {\n    listName\n    id\n    listId\n    __typename\n  }\n  ... on PodcastEpisodeListenAction {\n    id: audioId\n    podcastEpisodeLink\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on EpisodeWatchAction {\n    id: videoId\n    videoUrl\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on LinkAction {\n    id: linkId\n    linkId\n    link\n    linkType\n    openExternally\n    passUserIdentity\n    linkTokens {\n      __typename\n      placeholder\n      value\n    }\n    __typename\n  }\n  ... on ShareAction {\n    title\n    url\n    __typename\n  }\n  ... on SwitchTabAction {\n    referencedTabId\n    mediaType\n    link\n    __typename\n  }\n  ... on RadioEpisodeListenAction {\n    streamId\n    pageLink\n    startDate\n    __typename\n  }\n  ... on LiveListenAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n  ... on LiveWatchAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n}\nfragment imageFragment on Image {\n  __typename\n  objectId\n  alt\n  title\n  focalPoint\n  templateUrl\n}\nfragment tileFragment on Tile {\n  ... on IIdentifiable {\n    __typename\n    objectId\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n  ... on ITile {\n    description\n    title\n    active\n    action {\n      ...actionFragment\n      __typename\n    }\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    image {\n      ...imageFragment\n      __typename\n    }\n    primaryMeta {\n      ...metaFragment\n      __typename\n    }\n    secondaryMeta {\n      ...metaFragment\n      __typename\n    }\n    tertiaryMeta {\n      ...metaFragment\n      __typename\n    }\n    indexMeta {\n      __typename\n      type\n      value\n    }\n    statusMeta {\n      __typename\n      type\n      value\n    }\n    labelMeta {\n      __typename\n      type\n      value\n    }\n    __typename\n  }\n  ... on ContentTile {\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    __typename\n  }\n  ... on BannerTile {\n    compactLayout\n    backgroundColor\n    textTheme\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    ctaText\n    passUserIdentity\n    titleArt {\n      objectId\n      templateUrl\n      __typename\n    }\n    __typename\n  }\n  ... on EpisodeTile {\n    description\n    formattedDuration\n    available\n    chapterStart\n    action {\n      ...actionFragment\n      __typename\n    }\n    playAction: watchAction {\n      pageUrl: videoUrl\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    episode {\n      __typename\n      objectId\n      program {\n        __typename\n        objectId\n        link\n      }\n    }\n    \n    __typename\n  }\n  ... on PodcastEpisodeTile {\n    formattedDuration\n    available\n    programLink: podcastEpisode {\n      objectId\n      podcastProgram {\n        objectId\n        link\n        __typename\n      }\n      __typename\n    }\n    playAction: listenAction {\n      pageUrl: podcastEpisodeLink\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    __typename\n  }\n  ... on PodcastProgramTile {\n    link\n    __typename\n  }\n  ... on ProgramTile {\n    link\n    __typename\n  }\n  ... on AudioLivestreamTile {\n    brand\n    brandsLogos {\n      brand\n      brandTitle\n      logos {\n        ...brandLogosFragment\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  ... on LivestreamTile {\n    description\n    __typename\n  }\n  ... on ButtonTile {\n    icon\n    iconPosition\n    mode\n    __typename\n  }\n  ... on RadioEpisodeTile {\n    action {\n      ...actionFragment\n      __typename\n    }\n    available\n    \n    formattedDuration\n    ...componentTrackingDataFragment\n    __typename\n  }\n  ... on SongTile {\n    startDate\n    formattedStartDate\n    endDate\n    __typename\n  }\n  ... on RadioProgramTile {\n    objectId\n    __typename\n  }\n}\nfragment metaFragment on MetaDataItem {\n  __typename\n  type\n  value\n  shortValue\n  longValue\n}\nfragment componentTrackingDataFragment on IComponent {\n  trackingData {\n    data\n    perTrigger {\n      trigger\n      data\n      template {\n        id\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment brandLogosFragment on Logo {\n  colorOnColor\n  height\n  mono\n  primary\n  type\n  width\n}\nfragment paginatedTileListFragment on PaginatedTileList {\n  __typename\n  objectId\n  listId\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n  banner {\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    backgroundColor\n    compactLayout\n    description\n    image {\n      ...imageFragment\n      __typename\n    }\n    titleArt {\n      ...imageFragment\n      __typename\n    }\n    textTheme\n    title\n    __typename\n  }\n  bannerSize\n  displayType\n  expires\n  tileVariant\n  paginatedItems(first: $lazyItemCount, after: $after, before: $before) {\n    __typename\n    edges {\n      __typename\n      cursor\n      node {\n        __typename\n        ...tileFragment\n      }\n    }\n    pageInfo {\n      __typename\n      endCursor\n      hasNextPage\n      hasPreviousPage\n      startCursor\n    }\n  }\n  sort {\n    icon\n    order\n    title\n    __typename\n  }\n  tileContentType\n  tileOrientation\n  title\n  description\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n}',
                            'operationName': 'PaginatedTileListPage',
                            'variables': {'listId': c1["listId"]}
                        }
                    ).content.decode())
                    response = response["data"]["list"]

                    seasons.append((season_index, response))

                elif len(c1.get("items", [])) > 0:
                    tuples = [
                        (vrt_be.get_label_index(i["title"]), i)
                        for i in c1["items"]
                    ]
                    seasons = sorted([
                        (index, item) for index, item in tuples
                        if index is not None], key=lambda m: m[0]
                    ) + [(index, item) for index, item in tuples if index is None]

                if len(seasons) == 0:
                    seasons = [(vrt_be.get_label_index(i1["title"]), c1)]

                for season_index, season in seasons:
                    if season_index is None:
                        if (
                                selected_season_name is not None and
                                vrt_be.clean_title(season["title"]).startswith(selected_season_name)
                        ):
                            pass
                        else:
                            continue
                    if selected_season_name is not None and season_index is not None:
                        continue

                    try:
                        list_id = [c for c in season["components"] if len(c.get("listId", "")) > 0][0]["listId"]
                    except:
                        list_id = season["listId"]

                    if season_index is not None:
                        check = check_range(True, season_index, None)
                        if check is True:
                            continue
                        elif check is False:
                            return collection

                    response = json.loads(requests.post(
                        vrt_be.GRAPHQL_URL,
                        headers={'x-vrt-client-name': 'WEB'},
                        json={
                            'query': 'query ProgramSeasonEpisodeList($listId: ID!, $sort: SortInput, $lazyItemCount: Int = ' +
                                     str(vrt_be.PAGE_SIZE) +
                                     ', $after: ID, $before: ID) {\n  list(listId: $listId, sort: $sort) {\n    __typename\n    ... on PaginatedTileList {\n      ...paginatedTileListFragment\n      __typename\n    }\n    ... on StaticTileList {\n      ...staticTileListFragment\n      __typename\n    }\n  }\n}\nfragment staticTileListFragment on StaticTileList {\n  __typename\n  objectId\n  listId\n  title\n  description\n  tileContentType\n  tileOrientation\n  displayType\n  expires\n  tileVariant\n  sort {\n    icon\n    order\n    title\n    __typename\n  }\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n  banner {\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    description\n    image {\n      ...imageFragment\n      __typename\n    }\n    compactLayout\n    backgroundColor\n    textTheme\n    title\n    titleArt {\n      objectId\n      templateUrl\n      __typename\n    }\n    __typename\n  }\n  bannerSize\n  items {\n    ...tileFragment\n    __typename\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n}\nfragment actionItemFragment on ActionItem {\n  __typename\n  objectId\n  accessibilityLabel\n  action {\n    ...actionFragment\n    __typename\n  }\n  active\n  icon\n  iconPosition\n  icons {\n    __typename\n    position\n    ... on DesignSystemIcon {\n      value {\n        name\n        __typename\n      }\n      __typename\n    }\n  }\n  mode\n  objectId\n  title\n}\nfragment actionFragment on Action {\n  __typename\n  ... on FavoriteAction {\n    favorite\n    id\n    programUrl\n    programWhatsonId\n    title\n    __typename\n  }\n  ... on ListDeleteAction {\n    listName\n    id\n    listId\n    title\n    __typename\n  }\n  ... on ListTileDeletedAction {\n    listName\n    id\n    listId\n    __typename\n  }\n  ... on PodcastEpisodeListenAction {\n    id: audioId\n    podcastEpisodeLink\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on EpisodeWatchAction {\n    id: videoId\n    videoUrl\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on LinkAction {\n    id: linkId\n    linkId\n    link\n    linkType\n    openExternally\n    passUserIdentity\n    linkTokens {\n      __typename\n      placeholder\n      value\n    }\n    __typename\n  }\n  ... on ShareAction {\n    title\n    url\n    __typename\n  }\n  ... on SwitchTabAction {\n    referencedTabId\n    mediaType\n    link\n    __typename\n  }\n  ... on RadioEpisodeListenAction {\n    streamId\n    pageLink\n    startDate\n    __typename\n  }\n  ... on LiveListenAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n  ... on LiveWatchAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n}\nfragment imageFragment on Image {\n  __typename\n  objectId\n  alt\n  title\n  focalPoint\n  templateUrl\n}\nfragment tileFragment on Tile {\n  ... on IIdentifiable {\n    __typename\n    objectId\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n  ... on ITile {\n    description\n    title\n    active\n    action {\n      ...actionFragment\n      __typename\n    }\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    image {\n      ...imageFragment\n      __typename\n    }\n    primaryMeta {\n      ...metaFragment\n      __typename\n    }\n    secondaryMeta {\n      ...metaFragment\n      __typename\n    }\n    tertiaryMeta {\n      ...metaFragment\n      __typename\n    }\n    indexMeta {\n      __typename\n      type\n      value\n    }\n    statusMeta {\n      __typename\n      type\n      value\n    }\n    labelMeta {\n      __typename\n      type\n      value\n    }\n    __typename\n  }\n  ... on ContentTile {\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    __typename\n  }\n  ... on BannerTile {\n    compactLayout\n    backgroundColor\n    textTheme\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    ctaText\n    passUserIdentity\n    titleArt {\n      objectId\n      templateUrl\n      __typename\n    }\n    __typename\n  }\n  ... on EpisodeTile {\n    description\n    formattedDuration\n    available\n    chapterStart\n    action {\n      ...actionFragment\n      __typename\n    }\n    playAction: watchAction {\n      pageUrl: videoUrl\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    episode {\n      __typename\n      objectId\n      program {\n        __typename\n        objectId\n        link\n      }\n    }\n    \n    __typename\n  }\n  ... on PodcastEpisodeTile {\n    formattedDuration\n    available\n    programLink: podcastEpisode {\n      objectId\n      podcastProgram {\n        objectId\n        link\n        __typename\n      }\n      __typename\n    }\n    playAction: listenAction {\n      pageUrl: podcastEpisodeLink\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    __typename\n  }\n  ... on PodcastProgramTile {\n    link\n    __typename\n  }\n  ... on ProgramTile {\n    link\n    __typename\n  }\n  ... on AudioLivestreamTile {\n    brand\n    brandsLogos {\n      brand\n      brandTitle\n      logos {\n        ...brandLogosFragment\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  ... on LivestreamTile {\n    description\n    __typename\n  }\n  ... on ButtonTile {\n    icon\n    iconPosition\n    mode\n    __typename\n  }\n  ... on RadioEpisodeTile {\n    action {\n      ...actionFragment\n      __typename\n    }\n    available\n    \n    formattedDuration\n  ...componentTrackingDataFragment\n    __typename\n  }\n  ... on SongTile {\n    startDate\n    formattedStartDate\n    endDate\n    __typename\n  }\n  ... on RadioProgramTile {\n    objectId\n    __typename\n  }\n}\nfragment metaFragment on MetaDataItem {\n  __typename\n  type\n  value\n  shortValue\n  longValue\n}\nfragment componentTrackingDataFragment on IComponent {\n  trackingData {\n    data\n    perTrigger {\n      trigger\n      data\n      template {\n        id\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment brandLogosFragment on Logo {\n  colorOnColor\n  height\n  mono\n  primary\n  type\n  width\n}\nfragment paginatedTileListFragment on PaginatedTileList {\n  __typename\n  objectId\n  listId\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n  banner {\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    backgroundColor\n    compactLayout\n    description\n    image {\n      ...imageFragment\n      __typename\n    }\n    titleArt {\n      ...imageFragment\n      __typename\n    }\n    textTheme\n    title\n    __typename\n  }\n  bannerSize\n  displayType\n  expires\n  tileVariant\n  paginatedItems(first: $lazyItemCount, after: $after, before: $before) {\n    __typename\n    edges {\n      __typename\n      cursor\n      node {\n        __typename\n        ...tileFragment\n      }\n    }\n    pageInfo {\n      __typename\n      endCursor\n      hasNextPage\n      hasPreviousPage\n      startCursor\n    }\n  }\n  sort {\n    icon\n    order\n    title\n    __typename\n  }\n  tileContentType\n  tileOrientation\n  title\n  description\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n}',
                            'operationName': 'ProgramSeasonEpisodeList',
                            'variables': {'listId': list_id}
                        }
                    ).content.decode())

                    response = response["data"]["list"]
                    is_asc = None
                    if ignore_index:
                        is_asc = True

                    episode_index = 0
                    if response.get("paginatedItems", None) is not None:
                        while True:
                            edges = response["paginatedItems"].get("edges", [])
                            if is_asc is None:
                                is_asc = vrt_be.check_order("paginatedItems", edges)

                            for edge in edges:
                                e = edge["node"]
                                if e.get("playAction", None) is None:
                                    continue

                                episode_url = f'{vrt_be.BASE_URL}{e["playAction"]["pageUrl"]}'
                                if ignore_index:
                                    episode_index += 1
                                else:
                                    episode_index = vrt_be.get_episode_index(e["primaryMeta"], episode_url)

                                check = check_range(False, season_index, episode_index, is_asc)
                                if check is True:
                                    continue
                                elif check is False:
                                    return collection

                                collection.append(BaseElement(
                                    url=episode_url,
                                    collection=join(
                                        join(
                                            str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                            vrt_be.__name__
                                        ),
                                        collection_name if season_index is None else
                                        join(collection_name, f'Season_{season_index}')
                                    ),
                                    element=f'Episode_{episode_index}'
                                            f'_'
                                            f'{get_valid_filename(e["title"])}'
                                ))

                            page_info = response["paginatedItems"]["pageInfo"]
                            if page_info["hasNextPage"] is True:
                                response = json.loads(requests.post(
                                    vrt_be.GRAPHQL_URL,
                                    headers={'x-vrt-client-name': 'WEB'},
                                    json={
                                        'query': 'query ProgramSeasonEpisodeList($listId: ID!, $sort: SortInput, $lazyItemCount: Int = ' +
                                                 str(vrt_be.PAGE_SIZE) +
                                                 ', $after: ID, $before: ID) {\n  list(listId: $listId, sort: $sort) {\n    __typename\n    ... on PaginatedTileList {\n      ...paginatedTileListFragment\n      __typename\n    }\n    ... on StaticTileList {\n      ...staticTileListFragment\n      __typename\n    }\n  }\n}\nfragment staticTileListFragment on StaticTileList {\n  __typename\n  objectId\n  listId\n  title\n  description\n  tileContentType\n  tileOrientation\n  displayType\n  expires\n  tileVariant\n  sort {\n    icon\n    order\n    title\n    __typename\n  }\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n  banner {\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    description\n    image {\n      ...imageFragment\n      __typename\n    }\n    compactLayout\n    backgroundColor\n    textTheme\n    title\n    titleArt {\n      objectId\n      templateUrl\n      __typename\n    }\n    __typename\n  }\n  bannerSize\n  items {\n    ...tileFragment\n    __typename\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n}\nfragment actionItemFragment on ActionItem {\n  __typename\n  objectId\n  accessibilityLabel\n  action {\n    ...actionFragment\n    __typename\n  }\n  active\n  icon\n  iconPosition\n  icons {\n    __typename\n    position\n    ... on DesignSystemIcon {\n      value {\n        name\n        __typename\n      }\n      __typename\n    }\n  }\n  mode\n  objectId\n  title\n}\nfragment actionFragment on Action {\n  __typename\n  ... on FavoriteAction {\n    favorite\n    id\n    programUrl\n    programWhatsonId\n    title\n    __typename\n  }\n  ... on ListDeleteAction {\n    listName\n    id\n    listId\n    title\n    __typename\n  }\n  ... on ListTileDeletedAction {\n    listName\n    id\n    listId\n    __typename\n  }\n  ... on PodcastEpisodeListenAction {\n    id: audioId\n    podcastEpisodeLink\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on EpisodeWatchAction {\n    id: videoId\n    videoUrl\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on LinkAction {\n    id: linkId\n    linkId\n    link\n    linkType\n    openExternally\n    passUserIdentity\n    linkTokens {\n      __typename\n      placeholder\n      value\n    }\n    __typename\n  }\n  ... on ShareAction {\n    title\n    url\n    __typename\n  }\n  ... on SwitchTabAction {\n    referencedTabId\n    mediaType\n    link\n    __typename\n  }\n  ... on RadioEpisodeListenAction {\n    streamId\n    pageLink\n    startDate\n    __typename\n  }\n  ... on LiveListenAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n  ... on LiveWatchAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n}\nfragment imageFragment on Image {\n  __typename\n  objectId\n  alt\n  title\n  focalPoint\n  templateUrl\n}\nfragment tileFragment on Tile {\n  ... on IIdentifiable {\n    __typename\n    objectId\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n  ... on ITile {\n    description\n    title\n    active\n    action {\n      ...actionFragment\n      __typename\n    }\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    image {\n      ...imageFragment\n      __typename\n    }\n    primaryMeta {\n      ...metaFragment\n      __typename\n    }\n    secondaryMeta {\n      ...metaFragment\n      __typename\n    }\n    tertiaryMeta {\n      ...metaFragment\n      __typename\n    }\n    indexMeta {\n      __typename\n      type\n      value\n    }\n    statusMeta {\n      __typename\n      type\n      value\n    }\n    labelMeta {\n      __typename\n      type\n      value\n    }\n    __typename\n  }\n  ... on ContentTile {\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    __typename\n  }\n  ... on BannerTile {\n    compactLayout\n    backgroundColor\n    textTheme\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    ctaText\n    passUserIdentity\n    titleArt {\n      objectId\n      templateUrl\n      __typename\n    }\n    __typename\n  }\n  ... on EpisodeTile {\n    description\n    formattedDuration\n    available\n    chapterStart\n    action {\n      ...actionFragment\n      __typename\n    }\n    playAction: watchAction {\n      pageUrl: videoUrl\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    episode {\n      __typename\n      objectId\n      program {\n        __typename\n        objectId\n        link\n      }\n    }\n    \n    __typename\n  }\n  ... on PodcastEpisodeTile {\n    formattedDuration\n    available\n    programLink: podcastEpisode {\n      objectId\n      podcastProgram {\n        objectId\n        link\n        __typename\n      }\n      __typename\n    }\n    playAction: listenAction {\n      pageUrl: podcastEpisodeLink\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    __typename\n  }\n  ... on PodcastProgramTile {\n    link\n    __typename\n  }\n  ... on ProgramTile {\n    link\n    __typename\n  }\n  ... on AudioLivestreamTile {\n    brand\n    brandsLogos {\n      brand\n      brandTitle\n      logos {\n        ...brandLogosFragment\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  ... on LivestreamTile {\n    description\n    __typename\n  }\n  ... on ButtonTile {\n    icon\n    iconPosition\n    mode\n    __typename\n  }\n  ... on RadioEpisodeTile {\n    action {\n      ...actionFragment\n      __typename\n    }\n    available\n    \n    formattedDuration\n  ...componentTrackingDataFragment\n    __typename\n  }\n  ... on SongTile {\n    startDate\n    formattedStartDate\n    endDate\n    __typename\n  }\n  ... on RadioProgramTile {\n    objectId\n    __typename\n  }\n}\nfragment metaFragment on MetaDataItem {\n  __typename\n  type\n  value\n  shortValue\n  longValue\n}\nfragment componentTrackingDataFragment on IComponent {\n  trackingData {\n    data\n    perTrigger {\n      trigger\n      data\n      template {\n        id\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment brandLogosFragment on Logo {\n  colorOnColor\n  height\n  mono\n  primary\n  type\n  width\n}\nfragment paginatedTileListFragment on PaginatedTileList {\n  __typename\n  objectId\n  listId\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n  banner {\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    backgroundColor\n    compactLayout\n    description\n    image {\n      ...imageFragment\n      __typename\n    }\n    titleArt {\n      ...imageFragment\n      __typename\n    }\n    textTheme\n    title\n    __typename\n  }\n  bannerSize\n  displayType\n  expires\n  tileVariant\n  paginatedItems(first: $lazyItemCount, after: $after, before: $before) {\n    __typename\n    edges {\n      __typename\n      cursor\n      node {\n        __typename\n        ...tileFragment\n      }\n    }\n    pageInfo {\n      __typename\n      endCursor\n      hasNextPage\n      hasPreviousPage\n      startCursor\n    }\n  }\n  sort {\n    icon\n    order\n    title\n    __typename\n  }\n  tileContentType\n  tileOrientation\n  title\n  description\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n}',
                                        'operationName': 'ProgramSeasonEpisodeList',
                                        'variables': {'listId': list_id, 'after': page_info["endCursor"]}
                                    }
                                ).content.decode())
                                response = response["data"]["list"]
                                continue
                            break
                        continue

                    elif response.get("items", None) is not None:
                        if is_asc is None:
                            is_asc = vrt_be.check_order("items", response["items"])

                        for e in response["items"]:
                            if e.get("playAction", None) is None:
                                continue

                            episode_url = f'{vrt_be.BASE_URL}{e["playAction"]["pageUrl"]}'
                            if ignore_index:
                                episode_index += 1
                            else:
                                episode_index = vrt_be.get_episode_index(e["primaryMeta"], episode_url)

                            check = check_range(False, season_index, episode_index, is_asc)
                            if check is True:
                                continue
                            elif check is False:
                                return collection

                            collection.append(BaseElement(
                                url=episode_url,
                                collection=join(
                                    join(
                                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                        vrt_be.__name__
                                    ),
                                    collection_name if season_index is None else
                                    join(collection_name, f'Season_{season_index}')
                                ),
                                element=f'Episode_{episode_index}'
                                        f'_'
                                        f'{get_valid_filename(e["title"])}'
                            ))
                        continue

                    return None
        return collection

    @staticmethod
    def collection_handler(collection_url, season_name, fragment):
        if "/a-z/" in collection_url:
            response = json.loads(requests.post(
                vrt_be.GRAPHQL_URL,
                headers={'x-vrt-client-name': 'WEB'},
                json={
                    'query': 'query VideoProgramPage($pageId: ID!, $lazyItemCount: Int = ' +
                             str(vrt_be.PAGE_SIZE) +
                             ', $after: ID, $before: ID) {\n  page(id: $pageId) {\n    ... on ProgramPage {\n      objectId\n      permalink\n      seo {\n        ...seoFragment\n        __typename\n      }\n      socialSharing {\n        ...socialSharingFragment\n        __typename\n      }\n      trackingData {\n        ...trackingDataFragment\n        __typename\n      }\n      ldjson\n      components {\n        __typename\n        ... on IComponent {\n          ...componentTrackingDataFragment\n          __typename\n        }\n        ... on Banner {\n          ...bannerFragment\n          __typename\n        }\n        ... on PageHeader {\n          ...pageHeaderFragment\n          __typename\n        }\n        ... on ContainerNavigation {\n          objectId\n          navigationType\n          items {\n            objectId\n            title\n            active\n            components {\n              __typename\n              ... on IComponent {\n                ...componentTrackingDataFragment\n                __typename\n              }\n              ... on PaginatedTileList {\n                ...paginatedTileListFragment\n                __typename\n              }\n              ... on StaticTileList {\n                ...staticTileListFragment\n                __typename\n              }\n              ... on LazyTileList {\n                objectId\n                title\n                listId\n                __typename\n              }\n              ... on Banner {\n                ...bannerFragment\n                __typename\n              }\n              ... on IComponent {\n                ... on Text {\n                  ...textFragment\n                  __typename\n                }\n                ... on TagsList {\n                  objectId\n                  title\n                  tags {\n                    name\n                    title\n                    category\n                    __typename\n                  }\n                  __typename\n                }\n                ... on PresentersList {\n                  objectId\n                  title\n                  presenters {\n                    title\n                    type\n                    __typename\n                  }\n                  __typename\n                }\n                ... on ContainerNavigation {\n                  objectId\n                  navigationType\n                  items {\n                    objectId\n                    title\n                    components {\n                      __typename\n                      ... on Component {\n                        ... on PaginatedTileList {\n                          ...paginatedTileListFragment\n                          __typename\n                        }\n                        ... on StaticTileList {\n                          ...staticTileListFragment\n                          __typename\n                        }\n                        ... on LazyTileList {\n                          objectId\n                          title\n                          listId\n                          __typename\n                        }\n                        __typename\n                      }\n                    }\n                    __typename\n                  }\n                  __typename\n                }\n                __typename\n              }\n            }\n            __typename\n          }\n          __typename\n        }\n        ...paginatedTileListFragment\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment metaFragment on MetaDataItem {\n  __typename\n  type\n  value\n  shortValue\n  longValue\n}\nfragment staticTileListFragment on StaticTileList {\n  __typename\n  objectId\n  listId\n  title\n  description\n  tileContentType\n  tileOrientation\n  displayType\n  expires\n  tileVariant\n  sort {\n    icon\n    order\n    title\n    __typename\n  }\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n  banner {\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    description\n    image {\n      ...imageFragment\n      __typename\n    }\n    compactLayout\n    backgroundColor\n    textTheme\n    title\n    titleArt {\n      objectId\n      templateUrl\n      __typename\n    }\n    __typename\n  }\n  bannerSize\n  items {\n    ...tileFragment\n    __typename\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n}\nfragment actionItemFragment on ActionItem {\n  __typename\n  objectId\n  accessibilityLabel\n  action {\n    ...actionFragment\n    __typename\n  }\n  active\n  icon\n  iconPosition\n  icons {\n    __typename\n    position\n    ... on DesignSystemIcon {\n      value {\n        name\n        __typename\n      }\n      __typename\n    }\n  }\n  mode\n  objectId\n  title\n}\nfragment actionFragment on Action {\n  __typename\n  ... on FavoriteAction {\n    favorite\n    id\n    programUrl\n    programWhatsonId\n    title\n    __typename\n  }\n  ... on ListDeleteAction {\n    listName\n    id\n    listId\n    title\n    __typename\n  }\n  ... on ListTileDeletedAction {\n    listName\n    id\n    listId\n    __typename\n  }\n  ... on PodcastEpisodeListenAction {\n    id: audioId\n    podcastEpisodeLink\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on EpisodeWatchAction {\n    id: videoId\n    videoUrl\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on LinkAction {\n    id: linkId\n    linkId\n    link\n    linkType\n    openExternally\n    passUserIdentity\n    linkTokens {\n      __typename\n      placeholder\n      value\n    }\n    __typename\n  }\n  ... on ShareAction {\n    title\n    url\n    __typename\n  }\n  ... on SwitchTabAction {\n    referencedTabId\n    mediaType\n    link\n    __typename\n  }\n  ... on RadioEpisodeListenAction {\n    streamId\n    pageLink\n    startDate\n    __typename\n  }\n  ... on LiveListenAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n  ... on LiveWatchAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n}\nfragment imageFragment on Image {\n  __typename\n  objectId\n  alt\n  title\n  focalPoint\n  templateUrl\n}\nfragment tileFragment on Tile {\n  ... on IIdentifiable {\n    __typename\n    objectId\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n  ... on ITile {\n    description\n    title\n    active\n    action {\n      ...actionFragment\n      __typename\n    }\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    image {\n      ...imageFragment\n      __typename\n    }\n    primaryMeta {\n      ...metaFragment\n      __typename\n    }\n    secondaryMeta {\n      ...metaFragment\n      __typename\n    }\n    tertiaryMeta {\n      ...metaFragment\n      __typename\n    }\n    indexMeta {\n      __typename\n      type\n      value\n    }\n    statusMeta {\n      __typename\n      type\n      value\n    }\n    labelMeta {\n      __typename\n      type\n      value\n    }\n    __typename\n  }\n  ... on ContentTile {\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    __typename\n  }\n  ... on BannerTile {\n    compactLayout\n    backgroundColor\n    textTheme\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    ctaText\n    passUserIdentity\n    titleArt {\n      objectId\n      templateUrl\n      __typename\n    }\n    __typename\n  }\n  ... on EpisodeTile {\n    description\n    formattedDuration\n    available\n    chapterStart\n    action {\n      ...actionFragment\n      __typename\n    }\n    playAction: watchAction {\n      pageUrl: videoUrl\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    episode {\n      __typename\n      objectId\n      program {\n        __typename\n        objectId\n        link\n      }\n    }\n    \n    __typename\n  }\n  ... on PodcastEpisodeTile {\n    formattedDuration\n    available\n    programLink: podcastEpisode {\n      objectId\n      podcastProgram {\n        objectId\n        link\n        __typename\n      }\n      __typename\n    }\n    playAction: listenAction {\n      pageUrl: podcastEpisodeLink\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    __typename\n  }\n  ... on PodcastProgramTile {\n    link\n    __typename\n  }\n  ... on ProgramTile {\n    link\n    __typename\n  }\n  ... on AudioLivestreamTile {\n    brand\n    brandsLogos {\n      brand\n      brandTitle\n      logos {\n        ...brandLogosFragment\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  ... on LivestreamTile {\n    description\n    __typename\n  }\n  ... on ButtonTile {\n    icon\n    iconPosition\n    mode\n    __typename\n  }\n  ... on RadioEpisodeTile {\n    action {\n      ...actionFragment\n      __typename\n    }\n    available\n    \n    formattedDuration\n  ...componentTrackingDataFragment\n    __typename\n  }\n  ... on SongTile {\n    startDate\n    formattedStartDate\n    endDate\n    __typename\n  }\n  ... on RadioProgramTile {\n    objectId\n    __typename\n  }\n}\nfragment componentTrackingDataFragment on IComponent {\n  trackingData {\n    data\n    perTrigger {\n      trigger\n      data\n      template {\n        id\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment brandLogosFragment on Logo {\n  colorOnColor\n  height\n  mono\n  primary\n  type\n  width\n}\nfragment paginatedTileListFragment on PaginatedTileList {\n  __typename\n  objectId\n  listId\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n  banner {\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    backgroundColor\n    compactLayout\n    description\n    image {\n      ...imageFragment\n      __typename\n    }\n    titleArt {\n      ...imageFragment\n      __typename\n    }\n    textTheme\n    title\n    __typename\n  }\n  bannerSize\n  displayType\n  expires\n  tileVariant\n  paginatedItems(first: $lazyItemCount, after: $after, before: $before) {\n    __typename\n    edges {\n      __typename\n      cursor\n      node {\n        __typename\n        ...tileFragment\n      }\n    }\n    pageInfo {\n      __typename\n      endCursor\n      hasNextPage\n      hasPreviousPage\n      startCursor\n    }\n  }\n  sort {\n    icon\n    order\n    title\n    __typename\n  }\n  tileContentType\n  tileOrientation\n  title\n  description\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n}\nfragment pageHeaderFragment on PageHeader {\n  objectId\n  title\n  richShortDescription {\n    __typename\n    html\n  }\n  richDescription {\n    __typename\n    html\n  }\n  announcementValue\n  announcementType\n  mostRelevantEpisodeTile {\n    __typename\n    objectId\n    tile {\n      ...tileFragment\n      __typename\n    }\n    title\n  }\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n  secondaryMeta {\n    longValue\n    shortValue\n    type\n    value\n    __typename\n  }\n  image {\n    objectId\n    alt\n    focalPoint\n    templateUrl\n    __typename\n  }\n  categories {\n    category\n    name\n    title\n    __typename\n  }\n  presenters {\n    title\n    __typename\n  }\n  brands {\n    name\n    title\n    __typename\n  }\n  brandsLogos {\n    brand\n    brandTitle\n    logos {\n      mono\n      primary\n      type\n      __typename\n    }\n    __typename\n  }\n}\nfragment bannerFragment on Banner {\n  __typename\n  objectId\n  brand\n  countdown {\n    date\n    __typename\n  }\n  richDescription {\n    __typename\n    text\n  }\n  ctaText\n  image {\n    objectId\n    templateUrl\n    alt\n    focalPoint\n    __typename\n  }\n  title\n  compactLayout\n  textTheme\n  backgroundColor\n  style\n  action {\n    ...actionFragment\n    __typename\n  }\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n  titleArt {\n    objectId\n    templateUrl\n    __typename\n  }\n  labelMeta {\n    __typename\n    type\n    value\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n}\nfragment textFragment on Text {\n  __typename\n  objectId\n  html\n}\nfragment seoFragment on SeoProperties {\n  __typename\n  title\n  description\n}\nfragment socialSharingFragment on SocialSharingProperties {\n  __typename\n  title\n  description\n  image {\n    __typename\n    objectId\n    templateUrl\n  }\n}\nfragment trackingDataFragment on PageTrackingData {\n  data\n  perTrigger {\n    trigger\n    data\n    template {\n      id\n      __typename\n    }\n    __typename\n  }\n}',
                    'operationName': 'VideoProgramPage',
                    'variables': {'pageId': f'/vrtnu/{collection_url.split("/vrtmax/")[1]}.model.json'}
                }
            ).content.decode())

        elif "/podcasts/" in collection_url:
            response = json.loads(requests.post(
                vrt_be.GRAPHQL_URL,
                headers={'x-vrt-client-name': 'WEB'},
                json={
                    'query': 'query PodcastProgramPage($pageId: ID!) {\n  page(id: $pageId) {\n    ... on PodcastProgramPage {\n      objectId\n      permalink\n      seo {\n        ...seoFragment\n        __typename\n      }\n      socialSharing {\n        ...socialSharingFragment\n        __typename\n      }\n      trackingData {\n        ...trackingDataFragment\n        __typename\n      }\n      ldjson\n      components {\n        __typename\n        ... on IComponent {\n          ...pageHeaderFragment\n          ... on ContainerNavigation {\n            objectId\n            navigationType\n            items {\n              objectId\n              title\n              active\n              active\n              components {\n                __typename\n                ... on PaginatedTileList {\n                  __typename\n                  objectId\n                  sort {\n                    order\n                    __typename\n                  }\n                  title\n                  listId\n                  paginatedItems(first: 20) {\n                    edges {\n                      node {\n                        __typename\n                        ...tileFragment\n                      }\n                      __typename\n                    }\n                    pageInfo {\n                      __typename\n                      endCursor\n                      hasNextPage\n                      hasPreviousPage\n                      startCursor\n                    }\n                    __typename\n                  }\n                }\n                ... on IComponent {\n                  ... on Text {\n                    ...textFragment\n                    __typename\n                  }\n                  ... on TagsList {\n                    objectId\n                    title\n                    tags {\n                      name\n                      title\n                      category\n                      __typename\n                    }\n                    __typename\n                  }\n                  ... on PresentersList {\n                    objectId\n                    title\n                    presenters {\n                      title\n                      type\n                      __typename\n                    }\n                    __typename\n                  }\n                  ... on ContainerNavigation {\n                    objectId\n                    navigationType\n                    items {\n                      objectId\n                      title\n                      components {\n                        __typename\n                        ... on Component {\n                          ... on PaginatedTileList {\n                            __typename\n                            objectId\n                            sort {\n                              order\n                              __typename\n                            }\n                            title\n                            listId\n                            paginatedItems(first: 20) {\n                              edges {\n                                node {\n                                  __typename\n                                  ...tileFragment\n                                }\n                                cursor\n                                __typename\n                              }\n                              pageInfo {\n                                __typename\n                                endCursor\n                                hasNextPage\n                                hasPreviousPage\n                                startCursor\n                              }\n                              __typename\n                            }\n                          }\n                          ... on LazyTileList {\n                            objectId\n                            title\n                            listId\n                            __typename\n                          }\n                          __typename\n                        }\n                      }\n                      __typename\n                    }\n                    __typename\n                  }\n                  __typename\n                }\n              }\n              __typename\n            }\n            __typename\n          }\n          __typename\n        }\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment tileFragment on Tile {\n  ... on IIdentifiable {\n    __typename\n    objectId\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n  ... on ITile {\n    description\n    title\n    active\n    action {\n      ...actionFragment\n      __typename\n    }\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    image {\n      ...imageFragment\n      __typename\n    }\n    primaryMeta {\n      ...metaFragment\n      __typename\n    }\n    secondaryMeta {\n      ...metaFragment\n      __typename\n    }\n    tertiaryMeta {\n      ...metaFragment\n      __typename\n    }\n    indexMeta {\n      __typename\n      type\n      value\n    }\n    statusMeta {\n      __typename\n      type\n      value\n    }\n    labelMeta {\n      __typename\n      type\n      value\n    }\n    __typename\n  }\n  ... on ContentTile {\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    __typename\n  }\n  ... on BannerTile {\n    compactLayout\n    backgroundColor\n    textTheme\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    ctaText\n    passUserIdentity\n    titleArt {\n      objectId\n      templateUrl\n      __typename\n    }\n    __typename\n  }\n  ... on EpisodeTile {\n    description\n    formattedDuration\n    available\n    chapterStart\n    action {\n      ...actionFragment\n      __typename\n    }\n    playAction: watchAction {\n      pageUrl: videoUrl\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    episode {\n      __typename\n      objectId\n      program {\n        __typename\n        objectId\n        link\n      }\n    }\n    \n    __typename\n  }\n  ... on PodcastEpisodeTile {\n    formattedDuration\n    available\n    programLink: podcastEpisode {\n      objectId\n      podcastProgram {\n        objectId\n        link\n        __typename\n      }\n      __typename\n    }\n    playAction: listenAction {\n      pageUrl: podcastEpisodeLink\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    __typename\n  }\n  ... on PodcastProgramTile {\n    link\n    __typename\n  }\n  ... on ProgramTile {\n    link\n    __typename\n  }\n  ... on AudioLivestreamTile {\n    brand\n    brandsLogos {\n      brand\n      brandTitle\n      logos {\n        ...brandLogosFragment\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  ... on LivestreamTile {\n    description\n    __typename\n  }\n  ... on ButtonTile {\n    icon\n    iconPosition\n    mode\n    __typename\n  }\n  ... on RadioEpisodeTile {\n    action {\n      ...actionFragment\n      __typename\n    }\n    available\n    \n    formattedDuration\n  ...componentTrackingDataFragment\n    __typename\n  }\n  ... on SongTile {\n    startDate\n    formattedStartDate\n    endDate\n    __typename\n  }\n  ... on RadioProgramTile {\n    objectId\n    __typename\n  }\n}\nfragment metaFragment on MetaDataItem {\n  __typename\n  type\n  value\n  shortValue\n  longValue\n}\nfragment actionFragment on Action {\n  __typename\n  ... on FavoriteAction {\n    favorite\n    id\n    programUrl\n    programWhatsonId\n    title\n    __typename\n  }\n  ... on ListDeleteAction {\n    listName\n    id\n    listId\n    title\n    __typename\n  }\n  ... on ListTileDeletedAction {\n    listName\n    id\n    listId\n    __typename\n  }\n  ... on PodcastEpisodeListenAction {\n    id: audioId\n    podcastEpisodeLink\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on EpisodeWatchAction {\n    id: videoId\n    videoUrl\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on LinkAction {\n    id: linkId\n    linkId\n    link\n    linkType\n    openExternally\n    passUserIdentity\n    linkTokens {\n      __typename\n      placeholder\n      value\n    }\n    __typename\n  }\n  ... on ShareAction {\n    title\n    url\n    __typename\n  }\n  ... on SwitchTabAction {\n    referencedTabId\n    mediaType\n    link\n    __typename\n  }\n  ... on RadioEpisodeListenAction {\n    streamId\n    pageLink\n    startDate\n    __typename\n  }\n  ... on LiveListenAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n  ... on LiveWatchAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n}\nfragment actionItemFragment on ActionItem {\n  __typename\n  objectId\n  accessibilityLabel\n  action {\n    ...actionFragment\n    __typename\n  }\n  active\n  icon\n  iconPosition\n  icons {\n    __typename\n    position\n    ... on DesignSystemIcon {\n      value {\n        name\n        __typename\n      }\n      __typename\n    }\n  }\n  mode\n  objectId\n  title\n}\nfragment imageFragment on Image {\n  __typename\n  objectId\n  alt\n  title\n  focalPoint\n  templateUrl\n}\nfragment componentTrackingDataFragment on IComponent {\n  trackingData {\n    data\n    perTrigger {\n      trigger\n      data\n      template {\n        id\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment brandLogosFragment on Logo {\n  colorOnColor\n  height\n  mono\n  primary\n  type\n  width\n}\nfragment seoFragment on SeoProperties {\n  __typename\n  title\n  description\n}\nfragment socialSharingFragment on SocialSharingProperties {\n  __typename\n  title\n  description\n  image {\n    __typename\n    objectId\n    templateUrl\n  }\n}\nfragment textFragment on Text {\n  __typename\n  objectId\n  html\n}\nfragment pageHeaderFragment on PageHeader {\n  objectId\n  title\n  richShortDescription {\n    __typename\n    html\n  }\n  richDescription {\n    __typename\n    html\n  }\n  announcementValue\n  announcementType\n  mostRelevantEpisodeTile {\n    __typename\n    objectId\n    tile {\n      ...tileFragment\n      __typename\n    }\n    title\n  }\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n  secondaryMeta {\n    longValue\n    shortValue\n    type\n    value\n    __typename\n  }\n  image {\n    objectId\n    alt\n    focalPoint\n    templateUrl\n    __typename\n  }\n  categories {\n    category\n    name\n    title\n    __typename\n  }\n  presenters {\n    title\n    __typename\n  }\n  brands {\n    name\n    title\n    __typename\n  }\n  brandsLogos {\n    brand\n    brandTitle\n    logos {\n      mono\n      primary\n      type\n      __typename\n    }\n    __typename\n  }\n}\nfragment trackingDataFragment on PageTrackingData {\n  data\n  perTrigger {\n    trigger\n    data\n    template {\n      id\n      __typename\n    }\n    __typename\n  }\n}',
                    'operationName': 'PodcastProgramPage',
                    'variables': {'pageId': f'/vrtnu/{collection_url.split("/vrtmax/")[1]}.model.json'}
                }
            ).content.decode())

        elif "/luister/radio/" in collection_url:
            response = json.loads(requests.post(
                vrt_be.GRAPHQL_URL,
                headers={'x-vrt-client-name': 'WEB'},
                json={
                    'query': 'query RadioProgramPage($pageId: ID!) {\n  page(id: $pageId) {\n    __typename\n    ... on RadioProgramPage {\n      __typename\n      objectId\n      title\n      brand\n      permalink\n      seo {\n        ...seoFragment\n        __typename\n      }\n      socialSharing {\n        ...socialSharingFragment\n        __typename\n      }\n      trackingData {\n        ...trackingDataFragment\n        __typename\n      }\n      components {\n        __typename\n        ... on PageHeader {\n          ...pageHeaderFragment\n          __typename\n        }\n        ... on ContainerNavigation {\n          __typename\n          objectId\n          navigationType\n          items {\n            __typename\n            objectId\n            componentId\n            title\n            active\n          }\n        }\n      }\n    }\n  }\n}\nfragment metaFragment on MetaDataItem {\n  __typename\n  type\n  value\n  shortValue\n  longValue\n}\nfragment actionItemFragment on ActionItem {\n  __typename\n  objectId\n  accessibilityLabel\n  action {\n    ...actionFragment\n    __typename\n  }\n  active\n  icon\n  iconPosition\n  icons {\n    __typename\n    position\n    ... on DesignSystemIcon {\n      value {\n        name\n        __typename\n      }\n      __typename\n    }\n  }\n  mode\n  objectId\n  title\n}\nfragment actionFragment on Action {\n  __typename\n  ... on FavoriteAction {\n    favorite\n    id\n    programUrl\n    programWhatsonId\n    title\n    __typename\n  }\n  ... on ListDeleteAction {\n    listName\n    id\n    listId\n    title\n    __typename\n  }\n  ... on ListTileDeletedAction {\n    listName\n    id\n    listId\n    __typename\n  }\n  ... on PodcastEpisodeListenAction {\n    id: audioId\n    podcastEpisodeLink\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on EpisodeWatchAction {\n    id: videoId\n    videoUrl\n    resumePointProgress\n    resumePointTotal\n    completed\n    __typename\n  }\n  ... on LinkAction {\n    id: linkId\n    linkId\n    link\n    linkType\n    openExternally\n    passUserIdentity\n    linkTokens {\n      __typename\n      placeholder\n      value\n    }\n    __typename\n  }\n  ... on ShareAction {\n    title\n    url\n    __typename\n  }\n  ... on SwitchTabAction {\n    referencedTabId\n    mediaType\n    link\n    __typename\n  }\n  ... on RadioEpisodeListenAction {\n    streamId\n    pageLink\n    startDate\n    __typename\n  }\n  ... on LiveListenAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n  ... on LiveWatchAction {\n    streamId\n    livestreamPageLink\n    startDate\n    startOver\n    endDate\n    __typename\n  }\n}\nfragment imageFragment on Image {\n  __typename\n  objectId\n  alt\n  title\n  focalPoint\n  templateUrl\n}\nfragment tileFragment on Tile {\n  ... on IIdentifiable {\n    __typename\n    objectId\n  }\n  ... on IComponent {\n    ...componentTrackingDataFragment\n    __typename\n  }\n  ... on ITile {\n    description\n    title\n    active\n    action {\n      ...actionFragment\n      __typename\n    }\n    actionItems {\n      ...actionItemFragment\n      __typename\n    }\n    image {\n      ...imageFragment\n      __typename\n    }\n    primaryMeta {\n      ...metaFragment\n      __typename\n    }\n    secondaryMeta {\n      ...metaFragment\n      __typename\n    }\n    tertiaryMeta {\n      ...metaFragment\n      __typename\n    }\n    indexMeta {\n      __typename\n      type\n      value\n    }\n    statusMeta {\n      __typename\n      type\n      value\n    }\n    labelMeta {\n      __typename\n      type\n      value\n    }\n    __typename\n  }\n  ... on ContentTile {\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    __typename\n  }\n  ... on BannerTile {\n    compactLayout\n    backgroundColor\n    textTheme\n    brand\n    brandLogos {\n      ...brandLogosFragment\n      __typename\n    }\n    ctaText\n    passUserIdentity\n    titleArt {\n      objectId\n      templateUrl\n      __typename\n    }\n    __typename\n  }\n  ... on EpisodeTile {\n    description\n    formattedDuration\n    available\n    chapterStart\n    action {\n      ...actionFragment\n      __typename\n    }\n    playAction: watchAction {\n      pageUrl: videoUrl\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    episode {\n      __typename\n      objectId\n      program {\n        __typename\n        objectId\n        link\n      }\n    }\n    \n    __typename\n  }\n  ... on PodcastEpisodeTile {\n    formattedDuration\n    available\n    programLink: podcastEpisode {\n      objectId\n      podcastProgram {\n        objectId\n        link\n        __typename\n      }\n      __typename\n    }\n    playAction: listenAction {\n      pageUrl: podcastEpisodeLink\n      resumePointProgress\n      resumePointTotal\n      completed\n      __typename\n    }\n    __typename\n  }\n  ... on PodcastProgramTile {\n    link\n    __typename\n  }\n  ... on ProgramTile {\n    link\n    __typename\n  }\n  ... on AudioLivestreamTile {\n    brand\n    brandsLogos {\n      brand\n      brandTitle\n      logos {\n        ...brandLogosFragment\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  ... on LivestreamTile {\n    description\n    __typename\n  }\n  ... on ButtonTile {\n    icon\n    iconPosition\n    mode\n    __typename\n  }\n  ... on RadioEpisodeTile {\n    action {\n      ...actionFragment\n      __typename\n    }\n    available\n    \n    formattedDuration\n   ...componentTrackingDataFragment\n    __typename\n  }\n  ... on SongTile {\n    startDate\n    formattedStartDate\n    endDate\n    __typename\n  }\n  ... on RadioProgramTile {\n    objectId\n    __typename\n  }\n}\nfragment componentTrackingDataFragment on IComponent {\n  trackingData {\n    data\n    perTrigger {\n      trigger\n      data\n      template {\n        id\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\nfragment brandLogosFragment on Logo {\n  colorOnColor\n  height\n  mono\n  primary\n  type\n  width\n}\nfragment seoFragment on SeoProperties {\n  __typename\n  title\n  description\n}\nfragment socialSharingFragment on SocialSharingProperties {\n  __typename\n  title\n  description\n  image {\n    __typename\n    objectId\n    templateUrl\n  }\n}\nfragment trackingDataFragment on PageTrackingData {\n  data\n  perTrigger {\n    trigger\n    data\n    template {\n      id\n      __typename\n    }\n    __typename\n  }\n}\nfragment pageHeaderFragment on PageHeader {\n  objectId\n  title\n  richShortDescription {\n    __typename\n    html\n  }\n  richDescription {\n    __typename\n    html\n  }\n  announcementValue\n  announcementType\n  mostRelevantEpisodeTile {\n    __typename\n    objectId\n    tile {\n      ...tileFragment\n      __typename\n    }\n    title\n  }\n  actionItems {\n    ...actionItemFragment\n    __typename\n  }\n  secondaryMeta {\n    longValue\n    shortValue\n    type\n    value\n    __typename\n  }\n  image {\n    objectId\n    alt\n    focalPoint\n    templateUrl\n    __typename\n  }\n  categories {\n    category\n    name\n    title\n    __typename\n  }\n  presenters {\n    title\n    __typename\n  }\n  brands {\n    name\n    title\n    __typename\n  }\n  brandsLogos {\n    brand\n    brandTitle\n    logos {\n      mono\n      primary\n      type\n      __typename\n    }\n    __typename\n  }\n}',
                    'operationName': 'RadioProgramPage',
                    'variables': {'pageId': f'/vrtnu/{collection_url.split("/vrtmax/")[1]}/'}
                }
            ).content.decode())
        else:
            return None

        response = response["data"]["page"]["components"]
        try:
            collection_name = [c for c in response if c["__typename"] == "PageHeader"][0]["title"]
        except:
            collection_name = clean_url(collection_url).rstrip("/").split("/")[-1]
        collection_name = get_valid_filename(collection_name)

        for c1 in response:
            if c1["__typename"] == "PaginatedTileList":
                c1["components"] = [c1]
                return vrt_be.container_navigation_handler(
                    collection_name, {"items": [c1]},
                    season_name, fragment, collection_url
                )

            if c1["__typename"] == "ContainerNavigation":
                if fragment is None:
                    return None
                return vrt_be.container_navigation_handler(
                    collection_name, c1, season_name,
                    fragment, collection_url
                )

        return None

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.rstrip('/')
        if "/vrtmax/" not in collection_url:
            return None

        fragment = None
        if "#" in collection_url:
            fragment = urlparse(collection_url).fragment
            collection_url = collection_url.split(f'#{fragment}')[0].rstrip("/")

        season_name = None
        if "?" in collection_url and "seizoen=" in collection_url:
            season_name = parse_qs(urlparse(collection_url).query)["seizoen"][0]
            if "seizoen-" in season_name.lower():
                return None
            collection_url = collection_url.split('?')[0].rstrip("/")

        for p, i in [
            ("/a-z/", 0), ("/podcasts/", 2), ("/livestream/audio/", -1),
            ("/livestream/video/", -1), ("/luister/radio/", 1)
        ]:
            if p in collection_url:
                if 0 <= i == collection_url.split(p)[1].count("/"):
                    return vrt_be.collection_handler(collection_url, season_name, fragment)
                return [BaseElement(url=collection_url)]
        return None
