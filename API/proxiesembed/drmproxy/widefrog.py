import builtins
import os
import sys

from utils.constants.macros import CONFIG_FILE, INF_MSG, DEFAULT_DEBUG_MODE
from utils.main_service import main_service
from utils.tools.args import get_config, check_query_args, check_help_args, check_input_args, check_tool_args
from utils.tools.service import get_all_services


def test_service():
    main_service.run_service(
        # _35mm_online.DEMO_URLS +
        # adtv_ae.DEMO_URLS +
        # adultswim_com.DEMO_URLS +
        # aloula_sa.DEMO_URLS +
        # app_nzrplus_com.DEMO_URLS +
        # auvio_rtbf_be.DEMO_URLS +
        # canalplus_com.DEMO_URLS +
        # cbs_com.DEMO_URLS +
        # cda_pl.DEMO_URLS +
        # channel4_com.DEMO_URLS +
        # cineverse_com.DEMO_URLS +
        # docplus_com.DEMO_URLS +
        # eurovisionsport_com.DEMO_URLS +
        # fifa_com.DEMO_URLS +
        # filmzie_com.DEMO_URLS +
        # france_tv.DEMO_URLS +
        # goplay_be.DEMO_URLS +
        # joyn_de.DEMO_URLS +
        # kanopy_com.DEMO_URLS +
        # kijk_nl.DEMO_URLS +
        # m6_fr.DEMO_URLS +
        # maoriplus_co_nz.DEMO_URLS +
        # mediasetinfinity_mediaset_it.DEMO_URLS +
        # midnightpulp_com.DEMO_URLS +
        # mtv_fi.DEMO_URLS +
        # nba_com.DEMO_URLS +
        # nemzetiarchivum_hu.DEMO_URLS +
        # netflix_com.DEMO_URLS +
        # ninateka_pl.DEMO_URLS +
        # npo_nl.DEMO_URLS +
        # pianogroove_com.DEMO_URLS +
        # play_tv3_lt.DEMO_URLS +
        # play_tv3_lv.DEMO_URLS +
        # play_virginmediatelevision_ie.DEMO_URLS +
        # play_xumo_com.DEMO_URLS +
        # player_pl.DEMO_URLS +
        # plus_fifa_com.DEMO_URLS +
        # plus_rtl_de.DEMO_URLS +
        # ptvflix_org.DEMO_URLS +
        # rakuten_tv.DEMO_URLS +
        # rmcbfmplay_com.DEMO_URLS +
        # rsi_ch.DEMO_URLS +
        # rtlplay_be.DEMO_URLS +
        # rtp_pt.DEMO_URLS +
        # rts_ch.DEMO_URLS +
        # rtve_es.DEMO_URLS +
        # rugbypass_tv.DEMO_URLS +
        # shahid_mbc_net.DEMO_URLS +
        # stirr_com.DEMO_URLS +
        # tf1_fr.DEMO_URLS +
        # tg4_ie.DEMO_URLS +
        # threenow_co_nz.DEMO_URLS +
        # tv5mondeplus_com.DEMO_URLS +
        # uefa_tv.DEMO_URLS +
        # veeps_com.DEMO_URLS +
        # video_telequebec_tv.DEMO_URLS +
        # viki_com.DEMO_URLS +
        # viu_com.DEMO_URLS +
        # vix_com.DEMO_URLS +
        # vrt_be.DEMO_URLS +
        # vtmgo_be.DEMO_URLS +
        # watch_blaze_tv.DEMO_URLS +
        # watch_globaltv_com.DEMO_URLS +
        # watch_shortly_film.DEMO_URLS +
        # watch_tbn_uk.DEMO_URLS +
        # wittytv_it.DEMO_URLS +
        # zee5_com.DEMO_URLS +
        []
    )
    sys.exit(0)


def first_setup(arguments):
    is_first = not os.path.exists(CONFIG_FILE)
    builtins.CONFIG = get_config(arguments)
    builtins.CONFIG["QUERY"] = check_query_args(arguments)

    if "--debug" in arguments:
        builtins.CONFIG["DEBUG_MODE"] = True
    else:
        builtins.CONFIG["DEBUG_MODE"] = DEFAULT_DEBUG_MODE
    if "--fresh" in arguments:
        builtins.CONFIG["FRESH"] = True

    builtins.SERVICES = get_all_services()
    return is_first


if __name__ == '__main__':
    args = sys.argv[1:]
    response = check_help_args(args)
    if response is not None and len(response) > 0:
        print(response)
        sys.exit(0)

    if first_setup(args):
        print(INF_MSG.format(
            msg=f"The {CONFIG_FILE} file was created. Edit the file and run the program."
        ))
        sys.exit(0)

    bad_args = check_tool_args(builtins.CONFIG["DOWNLOAD_COMMANDS"]["TOOL_PARAMETERS"])
    if len(bad_args) > 0:
        print("Those arguments are not allowed: ", ", ".join(bad_args))
        sys.exit(0)

    # test_service()

    response = check_input_args(args)
    if len(response) == 0:
        sys.exit(0)
    main_service.run_service(response)
