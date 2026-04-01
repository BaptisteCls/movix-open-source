class BaseElement:
    def __init__(self, url=None, collection=None, element=None, additional=None):
        self.url = url
        self.collection = collection
        self.element = element
        self.additional = additional

    def copy(self, base_element):
        self.url = base_element.url
        self.collection = base_element.collection
        self.element = base_element.element
        self.additional = base_element.additional


class CustomException(Exception):
    def __init__(self, message):
        super().__init__(message)


class BaseService:

    @staticmethod
    def test_service():
        raise NotImplementedError(f'{BaseService.test_service.__name__} must be implemented')

    @staticmethod
    def is_content_livestream(content, additional):
        return False

    @staticmethod
    def get_additional_params(additional):
        return [("MUXER", lambda s: s.format(args="mkv"))]

    @staticmethod
    def credentials_needed():
        raise NotImplementedError(f'{BaseService.credentials_needed.__name__} must be implemented')

    @staticmethod
    def initialize_service():
        raise NotImplementedError(f'{BaseService.initialize_service.__name__} must be implemented')

    @staticmethod
    def get_best_decryptable_video(manifest, keys):
        return None

    @staticmethod
    def get_keys(challenge, additional):
        raise NotImplementedError(f'{BaseService.get_keys.__name__} must be implemented')

    @staticmethod
    def get_video_data(source_element):
        raise NotImplementedError(f'{BaseService.get_video_data.__name__} must be implemented')

    @staticmethod
    def get_collection_elements(collection_url):
        raise NotImplementedError(f'{BaseService.get_collection_elements.__name__} must be implemented')
